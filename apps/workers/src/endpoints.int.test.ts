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
import { deliver, RetryableSendError } from "./endpoints.ts";

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
const deps = () => ({ db, keys, guard, now: () => now });
const state = async (id: string) => (await listEndpoints(db, acme)).find((e) => e.id === id)?.state;

test("a webhook is signed over id.timestamp.body with the endpoint's secret, and sent once", async () => {
  answer = 204;
  const secret = newWebhookSecret();
  const { id, n } = await endpoint("webhook", "/hook", secret);
  const run = () => deliver("webhook", { endpointId: id, notice: n }, deps());
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

test("Slack gets Block Kit; a busy receiver is retried, a refusal marks the endpoint failing", async () => {
  answer = 200;
  const slack = await endpoint("slack", "/slack");
  expect(await deliver("slack", { endpointId: slack.id, notice: slack.n }, deps())).toBe("sent");
  expect(JSON.parse(received.at(-1)?.body ?? "{}").blocks[0].type).toBe("header");

  answer = 503;
  const busy = await endpoint("webhook", "/busy", newWebhookSecret());
  await expect(
    deliver("webhook", { endpointId: busy.id, notice: busy.n }, deps()),
  ).rejects.toBeInstanceOf(RetryableSendError);
  expect((await findDelivery(db, busy.n.eventId, { endpointId: busy.id }))?.status).toBe("pending");

  answer = 410;
  const gone = await endpoint("webhook", "/gone", newWebhookSecret());
  expect(await deliver("webhook", { endpointId: gone.id, notice: gone.n }, deps())).toBe("refused");
  expect(await state(gone.id)).toBe("failing");

  // It answers again: the next delivery brings the endpoint back.
  answer = 204;
  const next = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: next.eventId, subjectId: incidentId.parse(v7()) },
    [{ endpointId: gone.id, channel: "webhook" }],
  );
  expect(await deliver("webhook", { endpointId: gone.id, notice: next }, deps())).toBe("sent");
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
  expect(await deliver("webhook", { endpointId: id, notice: n }, deps())).toBe("skipped");
  expect(received.length).toBe(before);
});
