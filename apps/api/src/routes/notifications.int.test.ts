import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  eventId,
  incidentId,
  type Notice,
  type WebhookEndpointId,
  webhookEndpointId,
} from "@galena/contracts";
import { createEndpoint, findDelivery, recordDeliveries, schema, settleDelivery } from "@galena/db";
import { createGuard } from "@galena/integrations/net";
import { seal } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;
let app: ReturnType<typeof createApp>;
let workspaceId: string;
// The same deployment, but sending to a loopback receiver the real guard refuses.
let local: Session;

let answer = 204;
// While set, the receiver holds its answer until the test lets it go, telling it on arrival.
let hold: { arrived: () => void; release: Promise<void> } | undefined;
const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", async () => {
    received.push({ headers: req.headers, body });
    hold?.arrived();
    await hold?.release;
    res.statusCode = answer;
    res.end();
  });
});
let base = "";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  close = built.close;
  app = createApp(deps);
  owner = new Session(app);
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  workspaceId = ((await setup.json()) as { workspaceId: string }).workspaceId;
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  local = new Session(
    createApp({ ...deps, targets: createGuard({ allowAddresses: ["127.0.0.1"] }) }),
  );
  await local.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
});

afterAll(async () => {
  receiver.close();
  await close?.();
  await container?.stop();
});

type Created = { endpoint: { id: string; kind: string; state: string }; secret: string | null };

test("adds a Slack webhook and an outgoing webhook; neither URL comes back", async () => {
  const slack = await owner.call("/v1/webhook-endpoints", {
    kind: "slack",
    name: "#status",
    url: "https://hooks.slack.com/services/T000/B000/XXXX",
  });
  expect(slack.status).toBe(201);
  expect(((await slack.json()) as Created).secret).toBeNull();

  const hook = await owner.call("/v1/webhook-endpoints", {
    kind: "webhook",
    name: "Ops",
    url: "https://ops.example.com/galena",
  });
  const created = (await hook.json()) as Created;
  expect(created.secret).toMatch(/^whsec_/);

  const list = await owner.call("/v1/webhook-endpoints");
  const text = await list.text();
  expect(JSON.parse(text).map((e: { name: string }) => e.name)).toEqual(["#status", "Ops"]);
  expect(text).not.toContain("hooks.slack.com");
  expect(text).not.toContain("whsec_");

  expect(
    (await owner.call(`/v1/webhook-endpoints/${created.endpoint.id}`, undefined, "DELETE")).status,
  ).toBe(204);
  expect(((await (await owner.call("/v1/webhook-endpoints")).json()) as unknown[]).length).toBe(1);
});

test("refuses a Slack URL that isn't Slack's, plain http, and private addresses", async () => {
  const post = (url: string, kind = "webhook") =>
    owner.call("/v1/webhook-endpoints", { kind, name: "x", url });
  await expectProblem(await post("https://example.com/hook", "slack"), 400, "validation_failed");
  await expectProblem(await post("http://ops.example.com/hook"), 400, "validation_failed");
  await expectProblem(await post("https://127.0.0.1/hook"), 422, "blocked_by_guard");
});

test("a test message to an unreachable endpoint says so instead of failing", async () => {
  const id = webhookEndpointId.parse(v7());
  // Saved directly: the API wouldn't accept a loopback address, and sends refuse it too.
  await createEndpoint(deps.db, {
    id,
    workspaceId: workspaceId as never,
    kind: "webhook",
    name: "Local",
    componentIds: [],
    urlSealed: seal(deps.keys, "http://127.0.0.1:9/hook"),
    secretSealed: seal(deps.keys, "whsec_dGVzdA=="),
  });
  const res = await owner.call(`/v1/webhook-endpoints/${id}/test`, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false, status: 0 });
});

test("lists subscribers with masked addresses and removes one", async () => {
  await app.request("/public/subscribe", {
    method: "POST",
    body: new URLSearchParams({ email: "grace@example.com" }),
  });
  const list = (await (await owner.call("/v1/subscribers")).json()) as {
    id: string;
    email: string;
    state: string;
  }[];
  expect(list).toMatchObject([{ email: "g***@example.com", state: "pending_confirmation" }]);
  const id = list[0]?.id ?? "";
  expect((await owner.call(`/v1/subscribers/${id}`, undefined, "DELETE")).status).toBe(204);
  expect(await (await owner.call("/v1/subscribers")).json()).toEqual([]);
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit.find((a) => a.action === "subscriber.deleted")).toMatchObject({ targetId: id });
  await expectProblem(
    await owner.call(`/v1/subscribers/${id}`, undefined, "DELETE"),
    404,
    "not_found",
  );
});
const notice = (title: string): Notice => ({
  kind: "incident_created",
  eventId: eventId.parse(v7()),
  page: { name: "Acme", url: "https://status.example.com" },
  title,
  status: "investigating",
  impact: "major",
  components: [],
  body: "Looking into it.",
  startsAt: "2026-10-19T12:00:00.000Z",
  endsAt: null,
  occurredAt: "2026-10-19T12:00:00.000Z",
  url: "https://status.example.com/incidents/x/",
});

/** An outgoing webhook to the loopback receiver, saved directly (the API refuses loopback). */
async function localEndpoint(state: "active" | "failing" | "disabled" = "active") {
  const id = webhookEndpointId.parse(v7());
  await createEndpoint(deps.db, {
    id,
    workspaceId: workspaceId as never,
    kind: "webhook",
    name: `Receiver ${state}`,
    componentIds: [],
    urlSealed: seal(deps.keys, `${base}/hook`),
    secretSealed: seal(deps.keys, "whsec_dGVzdA=="),
  });
  if (state !== "active") {
    await deps.db
      .update(schema.webhookEndpoint)
      .set({ state, failingSince: new Date("2026-10-15T12:00:00Z") })
      .where(eq(schema.webhookEndpoint.id, id));
  }
  return id;
}

async function deliveryTo(id: WebhookEndpointId, n: Notice | undefined) {
  const event = n?.eventId ?? eventId.parse(v7());
  await recordDeliveries(
    deps.db,
    { workspaceId: workspaceId as never, eventId: event, subjectId: incidentId.parse(v7()) },
    [{ endpointId: id, channel: "webhook", ...(n && { notice: n }) }],
  );
  const row = await findDelivery(deps.db, event, { endpointId: id });
  if (!row) throw new Error("no delivery");
  return row.id;
}

const stateOf = async (id: string) => {
  const list = (await (await owner.call("/v1/webhook-endpoints")).json()) as Endpoint[];
  return list.find((e) => e.id === id)?.state;
};
type Endpoint = { id: string; state: string };

test("the delivery log shows what was sent; a failed delivery goes again with its webhook id", async () => {
  const id = await localEndpoint("failing");
  const failed = await deliveryTo(id, notice("Errors on API"));
  await settleDelivery(deps.db, failed, {
    status: "failed",
    attempts: 8,
    lastError: "The endpoint answered HTTP 503.",
  });
  const log = await owner.call(`/v1/webhook-endpoints/${id}/deliveries`);
  expect(await log.json()).toMatchObject([
    {
      id: failed,
      kind: "incident_created",
      title: "Errors on API",
      status: "failed",
      attempts: 8,
      lastError: "The endpoint answered HTTP 503.",
      sentAt: null,
    },
  ]);

  answer = 204;
  const resend = await local.call(`/v1/webhook-endpoints/${id}/deliveries/${failed}/resend`, {});
  expect(await resend.json()).toEqual({
    ok: true,
    status: 204,
    detail: "Sent again. The endpoint accepted it.",
  });
  const sent = received.at(-1);
  expect(sent?.headers["webhook-id"]).toBe(failed);
  expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ type: "incident.created" });
  const after = await (await owner.call(`/v1/webhook-endpoints/${id}/deliveries`)).json();
  expect(after).toMatchObject([{ status: "sent", attempts: 9, lastError: null }]);
  // It got through, so the endpoint isn't failing any more.
  expect(await stateOf(id)).toBe("active");
});

test("a failed resend is recorded on the delivery but leaves the endpoint as it was", async () => {
  const id = await localEndpoint();
  const sent = await deliveryTo(id, notice("Maintenance tonight"));
  await settleDelivery(deps.db, sent, { status: "sent", attempts: 1, sentAt: new Date() });
  answer = 503;
  const resend = await local.call(`/v1/webhook-endpoints/${id}/deliveries/${sent}/resend`, {});
  expect(await resend.json()).toEqual({
    ok: false,
    status: 503,
    detail: "Not sent. The endpoint answered HTTP 503.",
  });
  const after = await (await owner.call(`/v1/webhook-endpoints/${id}/deliveries`)).json();
  expect(after).toMatchObject([
    { status: "failed", attempts: 2, lastError: "The endpoint answered HTTP 503." },
  ]);
  expect(await stateOf(id)).toBe("active");
});

test("a second press while a resend is posting waits for it, and sends nothing more", async () => {
  const id = await localEndpoint();
  const failed = await deliveryTo(id, notice("Errors on checkout"));
  await settleDelivery(deps.db, failed, { status: "failed", attempts: 8, lastError: "HTTP 503" });
  const resend = () => local.call(`/v1/webhook-endpoints/${id}/deliveries/${failed}/resend`, {});
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    hold = { arrived: resolve, release: new Promise((r) => (release = r)) };
  });
  answer = 204;
  const before = received.length;
  const first = resend();
  try {
    await arrived;
    await expectProblem(await resend(), 409, "still_retrying");
  } finally {
    release();
    hold = undefined;
  }
  expect((await first).status).toBe(200);
  expect(received.length - before).toBe(1);
});

test("a pending delivery whose next attempt is long overdue can be sent again", async () => {
  const id = await localEndpoint();
  const lost = await deliveryTo(id, notice("Slow search"));
  // Attempt 7 failed 27 hours ago; attempt 8, due 24 hours later, never came.
  await deps.db
    .update(schema.delivery)
    .set({ attempts: 7, updatedAt: new Date(Date.now() - 27 * 3_600_000) })
    .where(eq(schema.delivery.id, lost));
  answer = 204;
  const resend = await local.call(`/v1/webhook-endpoints/${id}/deliveries/${lost}/resend`, {});
  expect(await resend.json()).toMatchObject({ ok: true });
  const after = await (await owner.call(`/v1/webhook-endpoints/${id}/deliveries`)).json();
  expect(after).toMatchObject([{ status: "sent", attempts: 8 }]);
});

test("a delivery still retrying, one sent before notices were kept, or to an endpoint that is off, isn't sent again", async () => {
  const id = await localEndpoint();
  const resend = (delivery: string, endpoint: string = id) =>
    local.call(`/v1/webhook-endpoints/${endpoint}/deliveries/${delivery}/resend`, {});
  await expectProblem(await resend(await deliveryTo(id, notice("Slow"))), 409, "still_retrying");
  const old = await deliveryTo(id, undefined);
  await settleDelivery(deps.db, old, { status: "sent", attempts: 1, sentAt: new Date() });
  await expectProblem(await resend(old), 409, "not_kept");

  const off = await localEndpoint("disabled");
  const kept = await deliveryTo(off, notice("Down"));
  await settleDelivery(deps.db, kept, { status: "skipped", attempts: 1 });
  await expectProblem(await resend(kept, off), 409, "endpoint_disabled");
  // Another endpoint's delivery, and an endpoint that isn't there.
  await expectProblem(await resend(kept), 404, "not_found");
  await expectProblem(
    await owner.call(`/v1/webhook-endpoints/${webhookEndpointId.parse(v7())}/deliveries`),
    404,
    "not_found",
  );
});

test("an endpoint that was turned off is on again only once a test message gets through", async () => {
  const id = await localEndpoint("disabled");
  const enable = () => local.call(`/v1/webhook-endpoints/${id}/enable`, {});
  answer = 500;
  expect(await (await enable()).json()).toEqual({
    ok: false,
    status: 500,
    detail: "Still off. The endpoint answered HTTP 500. Fix the receiver, then turn it on again.",
  });
  expect(await stateOf(id)).toBe("disabled");

  answer = 204;
  expect(await (await enable()).json()).toEqual({
    ok: true,
    status: 204,
    detail: "Turned on. The endpoint accepted the test message.",
  });
  expect(received.at(-1)?.headers["webhook-id"]).toMatch(/^test_/);
  expect(await stateOf(id)).toBe("active");
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit.find((a) => a.action === "webhook_endpoint.updated")).toMatchObject({
    targetId: id,
  });
  await expectProblem(await enable(), 409, "not_disabled");
});

test("a workspace sends at most 20 test messages and resends a minute", async () => {
  const id = await localEndpoint();
  const fresh = new Session(
    createApp({ ...deps, targets: createGuard({ allowAddresses: ["127.0.0.1"] }) }),
  );
  await fresh.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  answer = 204;
  for (let i = 0; i < 20; i++) {
    expect((await fresh.call(`/v1/webhook-endpoints/${id}/test`, {})).status).toBe(200);
  }
  await expectProblem(
    await fresh.call(`/v1/webhook-endpoints/${id}/test`, {}),
    429,
    "too_many_sends",
  );
});
