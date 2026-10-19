import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  componentId,
  eventId,
  incidentId,
  type Notice,
  webhookEndpointId,
  workspaceId,
} from "@galena/contracts";
import {
  createDb,
  createEndpoint,
  type Db,
  findDelivery,
  listEndpoints,
  recordDeliveries,
  schema,
} from "@galena/db";
import { newWebhookSecret } from "@galena/integrations/channels";
import { createGuard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY, seal } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { deliver, type EndpointDeps, type EndpointPayload } from "./endpoints.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const keys = appKeys(LOCAL_APP_KEY);
const now = new Date("2026-09-30T12:00:00.000Z");
// The test receiver runs on loopback, which only this guard lets through.
const guard = createGuard({ allowAddresses: ["127.0.0.1"] });

let base = "";
let answer = 204;
const received: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    received.push({ path: req.url ?? "", headers: req.headers, body });
    res.statusCode = answer;
    res.end();
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
});

afterAll(async () => {
  receiver.close();
  await close?.();
  await container?.stop();
});

const notice = (): Notice => ({
  kind: "incident_created",
  eventId: eventId.parse(v7()),
  page: { name: "Acme", url: "https://status.example.com" },
  title: "Errors on API",
  status: "investigating",
  impact: "major",
  components: [{ id: componentId.parse(v7()), name: "API", status: "partial_outage" }],
  body: "Looking into it.",
  startsAt: now.toISOString(),
  endsAt: null,
  occurredAt: now.toISOString(),
  url: "https://status.example.com/incidents/x/",
});

async function endpoint(kind: "slack" | "webhook", path: string, secret?: string) {
  const id = webhookEndpointId.parse(v7());
  await createEndpoint(db, {
    id,
    workspaceId: acme,
    kind,
    name: path,
    componentIds: [],
    urlSealed: seal(keys, `${base}${path}`),
    secretSealed: secret ? seal(keys, secret) : null,
  });
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [{ endpointId: id, channel: kind }],
  );
  return { id, n };
}
const scheduled: { next: EndpointPayload; at: Date }[] = [];
const deps = (over: Partial<EndpointDeps> = {}): EndpointDeps => ({
  db,
  keys,
  guard,
  now: () => now,
  redelivered: false,
  retry: async (next, at) => {
    scheduled.push({ next, at });
  },
  ...over,
});
const first = (id: EndpointPayload["endpointId"], n: Notice): EndpointPayload => ({
  endpointId: id,
  notice: n,
  attempt: 1,
});
const state = async (id: string) => (await listEndpoints(db, acme)).find((e) => e.id === id)?.state;

test("a webhook is signed over id.timestamp.body with the endpoint's secret, and sent once", async () => {
  answer = 204;
  const secret = newWebhookSecret();
  const { id, n } = await endpoint("webhook", "/hook", secret);
  const run = () => deliver("webhook", first(id, n), deps());
  expect(await run()).toBe("sent");
  expect(await run()).toBe("already_settled");
  const [sent] = received.filter((r) => r.path === "/hook");
  const signed = `${sent?.headers["webhook-id"]}.${sent?.headers["webhook-timestamp"]}.${sent?.body}`;
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(signed)
    .digest("base64");
  expect(sent?.headers["webhook-signature"]).toBe(`v1,${expected}`);
  expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ type: "incident.created" });
  const delivery = await findDelivery(db, n.eventId, { endpointId: id });
  expect([delivery?.status, sent?.headers["webhook-id"]]).toEqual(["sent", delivery?.id]);
});

test("Slack gets Block Kit; a busy receiver gets its next attempt later, a refusal marks the endpoint failing", async () => {
  answer = 200;
  const slack = await endpoint("slack", "/slack");
  expect(await deliver("slack", first(slack.id, slack.n), deps())).toBe("sent");
  expect(JSON.parse(received.at(-1)?.body ?? "{}").blocks[0].type).toBe("header");

  answer = 503;
  const busy = await endpoint("webhook", "/busy", newWebhookSecret());
  scheduled.length = 0;
  expect(await deliver("webhook", first(busy.id, busy.n), deps())).toBe("retrying");
  expect(scheduled).toEqual([
    { next: { ...first(busy.id, busy.n), attempt: 2 }, at: new Date(now.getTime() + 5_000) },
  ]);
  expect(await findDelivery(db, busy.n.eventId, { endpointId: busy.id })).toMatchObject({
    status: "pending",
    attempts: 1,
  });
  // Attempt 2, at its time, finds it answering again.
  answer = 204;
  const retry = scheduled[0]?.next ?? first(busy.id, busy.n);
  expect(await deliver("webhook", retry, deps())).toBe("sent");

  answer = 410;
  const gone = await endpoint("webhook", "/gone", newWebhookSecret());
  expect(await deliver("webhook", first(gone.id, gone.n), deps())).toBe("refused");
  expect(await state(gone.id)).toBe("failing");

  // It answers again: the next delivery brings the endpoint back.
  answer = 204;
  const next = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: next.eventId, subjectId: incidentId.parse(v7()) },
    [{ endpointId: gone.id, channel: "webhook" }],
  );
  expect(await deliver("webhook", first(gone.id, next), deps())).toBe("sent");
  expect(await state(gone.id)).toBe("active");
});

test("a disabled endpoint is skipped without a request", async () => {
  const id = webhookEndpointId.parse(v7());
  await db.insert(schema.webhookEndpoint).values({
    id,
    workspaceId: acme,
    kind: "webhook",
    name: "Off",
    componentIds: [],
    urlSealed: seal(keys, `${base}/off`),
    secretSealed: seal(keys, newWebhookSecret()),
    state: "disabled",
  });
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [{ endpointId: id, channel: "webhook" }],
  );
  const before = received.length;
  expect(await deliver("webhook", first(id, n), deps())).toBe("skipped");
  expect(received.length).toBe(before);
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Runs a delivery's attempts, each at the time the one before asked for, until it settles. */
async function attempts(id: EndpointPayload["endpointId"], start: Date) {
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [{ endpointId: id, channel: "webhook", notice: n }],
  );
  let request = first(id, n);
  let at = start;
  const outcomes: string[] = [];
  for (;;) {
    let later: { next: EndpointPayload; at: Date } | undefined;
    const retry = async (next: EndpointPayload, when: Date) => {
      later = { next, at: when };
    };
    const outcome = await deliver("webhook", request, deps({ now: () => at, retry }));
    outcomes.push(outcome);
    if (!later) return { outcomes, settledAt: at, eventId: n.eventId };
    ({ next: request, at } = later);
  }
}

test("a receiver down for days: failing after its first delivery's 8 attempts, off 3 days on", async () => {
  answer = 503;
  const { id } = await endpoint("webhook", "/down", newWebhookSecret());
  const byEndpoint = () => received.filter((r) => r.path === "/down").length;

  const one = await attempts(id, now);
  expect(one.outcomes).toEqual([...Array(7).fill("retrying"), "failed"]);
  // 5 s, 30 s, 2 min, 10 min, 1 h, 6 h and 24 h after one another.
  expect(one.settledAt.getTime() - now.getTime()).toBe(31 * HOUR + 12 * 60_000 + 35_000);
  expect(await findDelivery(db, one.eventId, { endpointId: id })).toMatchObject({
    status: "failed",
    attempts: 8,
  });
  const failing = { state: "failing", failingSince: one.settledAt };
  expect((await listEndpoints(db, acme)).find((e) => e.id === id)).toMatchObject(failing);

  // Failing for 32 hours: not yet off.
  const two = await attempts(id, new Date(one.settledAt.getTime() + HOUR));
  expect(two.outcomes.at(-1)).toBe("failed");
  expect((await listEndpoints(db, acme)).find((e) => e.id === id)).toMatchObject(failing);

  // A delivery that runs out 3 days after the first one did turns it off...
  const three = await attempts(id, new Date(one.settledAt.getTime() + 2 * DAY));
  expect(three.settledAt.getTime() - one.settledAt.getTime()).toBeGreaterThanOrEqual(3 * DAY);
  expect(await state(id)).toBe("disabled");

  // ...and what comes after is skipped without a request.
  const before = byEndpoint();
  const four = await attempts(id, new Date(three.settledAt.getTime() + HOUR));
  expect([four.outcomes, byEndpoint()]).toEqual([["skipped"], before]);
  expect(byEndpoint()).toBe(3 * 8);
});

test("an attempt whose run died after claiming it is taken again only when the queue hands it back", async () => {
  answer = 503;
  const { id, n } = await endpoint("webhook", "/flaky", newWebhookSecret());
  const queueDown = async () => {
    throw new Error("the queue is unreachable");
  };
  await expect(deliver("webhook", first(id, n), deps({ retry: queueDown }))).rejects.toThrow();
  // A copy of the same attempt that wasn't handed back can't claim it.
  expect(await deliver("webhook", first(id, n), deps())).toBe("already_settled");
  scheduled.length = 0;
  expect(await deliver("webhook", first(id, n), deps({ redelivered: true }))).toBe("retrying");
  expect(scheduled.map((s) => s.next.attempt)).toEqual([2]);
});
