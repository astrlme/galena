import {
  type DeliveryStatus,
  deliveryId,
  type EventId,
  eventId,
  type IncidentEvidence,
  type IncidentId,
  incidentEvidence,
  incidentId,
  integrationId,
  type MonitorId,
  type MonitorState,
  monitorId,
  type RecentCheck,
  type SubscriberId,
  subscriberId,
  type WebhookEndpointId,
  type WorkspaceId,
  webhookEndpointId,
  workspaceId,
} from "@galena/contracts";
import { monitorDedupKey, signalDedupKey } from "@galena/core";
import { incidentRepository, schema } from "@galena/db";
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
let checks: Map<MonitorId, RecentCheck[]>;
let owner: Session;
let acme: WorkspaceId;
let monitor: MonitorId;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  checks = built.checks;
  close = built.close;
  owner = new Session(createApp(deps));
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(setup.status).toBe(201);
  const [row] = await deps.db.select({ id: schema.workspace.id }).from(schema.workspace);
  acme = workspaceId.parse(row?.id);
  const created = await owner.call("/v1/monitors", {
    name: "Checkout",
    http: { url: "https://example.com/checkout" },
  });
  expect(created.status).toBe(201);
  monitor = ((await created.json()) as { id: MonitorId }).id;
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const at = (iso: string) => new Date(iso);

async function evidence(id: IncidentId): Promise<IncidentEvidence> {
  const response = await owner.call(`/v1/incidents/${id}/evidence`);
  expect(response.status, await response.clone().text()).toBe(200);
  // The contract: whatever the route answers must match the published schema.
  return incidentEvidence.parse(await response.json());
}

async function insertIncident(
  fields: Partial<typeof schema.incident.$inferInsert> & { startedAt: Date },
): Promise<IncidentId> {
  const id = incidentId.parse(v7());
  await deps.db.insert(schema.incident).values({
    id,
    workspaceId: acme,
    title: "Checkout is down",
    status: "investigating",
    impact: "major",
    ...fields,
  });
  return id;
}

const check = (scheduledAt: string, region: string, status: "up" | "down"): RecentCheck => ({
  region,
  scheduledAt,
  status,
  latencyMs: status === "up" ? 120 : null,
  error: status === "up" ? null : { code: "timeout", message: "Timed out after 10 s." },
});

async function stateChange(
  seq: number,
  iso: string,
  fromState: MonitorState,
  toState: MonitorState,
) {
  await deps.db.insert(schema.monitorStateChange).values({
    id: v7(),
    workspaceId: acme,
    monitorId: monitor,
    fromState,
    toState,
    seq,
    at: at(iso),
  });
}

test("a monitor incident shows the monitor's checks and state changes from 30 minutes before", async () => {
  checks.set(monitor, [
    check("2026-11-08T09:29:00.000Z", "eu-west-1", "up"),
    check("2026-11-08T09:30:00.000Z", "eu-west-1", "up"),
    check("2026-11-08T10:00:00.000Z", "eu-west-1", "down"),
    check("2026-11-08T10:00:00.000Z", "eu-west-3", "down"),
    check("2026-11-08T10:20:00.000Z", "eu-west-1", "up"),
    check("2026-11-08T10:21:00.000Z", "eu-west-1", "up"),
  ]);
  await stateChange(1, "2026-11-08T09:00:00.000Z", "unknown", "up");
  await stateChange(2, "2026-11-08T10:01:00.000Z", "up", "down");
  await stateChange(3, "2026-11-08T10:18:00.000Z", "down", "recovering");
  await stateChange(4, "2026-11-08T10:20:00.000Z", "recovering", "up");
  const id = await insertIncident({
    source: "monitor",
    dedupKey: monitorDedupKey(monitor),
    startedAt: at("2026-11-08T10:01:00.000Z"),
    resolvedAt: at("2026-11-08T10:20:00.000Z"),
    status: "resolved",
  });

  const { monitor: shown, timeline, notifications } = await evidence(id);

  expect(shown).toEqual({
    id: monitor,
    name: "Checkout",
    type: "http",
    regions: ["eu-west-1", "eu-west-3", "eu-north-1"],
    window: { from: "2026-11-08T09:31:00.000Z", to: "2026-11-08T10:20:00.000Z", gap: null },
    results: [
      check("2026-11-08T10:00:00.000Z", "eu-west-1", "down"),
      check("2026-11-08T10:00:00.000Z", "eu-west-3", "down"),
      check("2026-11-08T10:20:00.000Z", "eu-west-1", "up"),
    ],
    transitions: [
      { from: "up", to: "down", at: "2026-11-08T10:01:00.000Z" },
      { from: "down", to: "recovering", at: "2026-11-08T10:18:00.000Z" },
      { from: "recovering", to: "up", at: "2026-11-08T10:20:00.000Z" },
    ],
  });
  expect(timeline).toEqual([]);
  expect(notifications).toEqual([]);
});

test("a long incident keeps its first and latest hour and leaves out the middle", async () => {
  checks.set(monitor, [
    check("2026-11-07T09:30:00.000Z", "eu-west-1", "up"),
    check("2026-11-07T10:30:00.000Z", "eu-west-1", "down"),
    check("2026-11-07T10:31:00.000Z", "eu-west-1", "down"),
    check("2026-11-08T08:59:00.000Z", "eu-west-1", "down"),
    check("2026-11-08T09:00:00.000Z", "eu-west-1", "down"),
    check("2026-11-08T10:00:00.000Z", "eu-west-1", "up"),
  ]);
  const id = await insertIncident({
    source: "monitor",
    dedupKey: monitorDedupKey(monitor),
    startedAt: at("2026-11-07T10:00:00.000Z"),
    resolvedAt: at("2026-11-08T10:00:00.000Z"),
    status: "resolved",
  });

  const shown = (await evidence(id)).monitor;

  expect(shown?.window).toEqual({
    from: "2026-11-07T09:30:00.000Z",
    to: "2026-11-08T10:00:00.000Z",
    gap: { from: "2026-11-07T10:30:00.000Z", to: "2026-11-08T09:00:00.000Z" },
  });
  expect(shown?.results.map((r) => r.scheduledAt)).toEqual([
    "2026-11-07T09:30:00.000Z",
    "2026-11-07T10:30:00.000Z",
    "2026-11-08T09:00:00.000Z",
    "2026-11-08T10:00:00.000Z",
  ]);
});

test("an open incident reads up to now, and a deleted monitor's incident has no checks", async () => {
  const startedAt = new Date(Date.now() - 10 * 60_000);
  const open = await insertIncident({
    source: "monitor",
    dedupKey: monitorDedupKey(monitor),
    startedAt,
  });
  const before = Date.now();
  const window = (await evidence(open)).monitor?.window;
  expect(window?.gap).toBeNull();
  expect(Date.parse(window?.to ?? "")).toBeGreaterThanOrEqual(before);

  const gone = await insertIncident({
    source: "monitor",
    dedupKey: monitorDedupKey(monitorId.parse(v7())),
    startedAt,
  });
  expect((await evidence(gone)).monitor).toBeNull();
});

test("an alert incident shows each alert group's labels and its integration's name", async () => {
  const integration = integrationId.parse(v7());
  await deps.db.insert(schema.integration).values({
    id: integration,
    workspaceId: acme,
    source: "alertmanager",
    name: "Production Alertmanager",
    tokenIssuedAt: at("2026-11-08T09:00:00.000Z"),
  });
  const id = await insertIncident({
    source: "signal",
    dedupKey: signalDedupKey(integration, "fp-1"),
    startedAt: at("2026-11-08T12:00:00.000Z"),
  });
  const alerts = [
    { alertname: "HighErrorRate", service: "checkout", severity: "critical" },
    { alertname: "HighErrorRate", service: "payments", severity: "critical" },
  ];
  const incidents = incidentRepository(deps.db);
  await incidents.noteSignal(
    acme,
    id,
    {
      key: "run-1",
      integrationId: integration,
      title: "HighErrorRate",
      status: "firing",
      alerts,
    },
    at("2026-11-08T12:00:00.000Z"),
  );
  await incidents.noteSignal(
    acme,
    id,
    {
      key: "run-2",
      integrationId: integration,
      title: "HighErrorRate",
      status: "resolved",
      alerts,
    },
    at("2026-11-08T12:30:00.000Z"),
  );

  const shown = await evidence(id);

  expect(shown.monitor).toBeNull();
  expect(shown.timeline).toEqual([
    {
      kind: "signal",
      at: "2026-11-08T12:00:00.000Z",
      integrationId: integration,
      integrationName: "Production Alertmanager",
      title: "HighErrorRate",
      status: "firing",
      alerts,
      alertCount: 2,
    },
    {
      kind: "signal",
      at: "2026-11-08T12:30:00.000Z",
      integrationId: integration,
      integrationName: "Production Alertmanager",
      title: "HighErrorRate",
      status: "resolved",
      alerts,
      alertCount: 2,
    },
  ]);

  // The notes outlive the integration; only its name goes.
  await deps.db.delete(schema.integration).where(eq(schema.integration.id, integration));
  const after = await evidence(id);
  expect(after.timeline.map((e) => e.kind === "signal" && e.integrationName)).toEqual([null, null]);
});

test("alert labels stay within what one response can carry", async () => {
  const integration = integrationId.parse(v7());
  await deps.db.insert(schema.integration).values({
    id: integration,
    workspaceId: acme,
    source: "generic",
    name: "Noisy",
    tokenIssuedAt: at("2026-11-08T09:00:00.000Z"),
  });
  const id = await insertIncident({
    source: "signal",
    dedupKey: signalDedupKey(integration, "fp-2"),
    startedAt: at("2026-11-08T15:00:00.000Z"),
  });
  const many = Array.from({ length: 25 }, (_, n) => ({ alertname: "DiskFull", host: `db-${n}` }));
  // As big as a note gets: 20 shown alerts of 64 labels with 1,000-character values.
  const huge = Array.from({ length: 20 }, (_, n) =>
    Object.fromEntries(Array.from({ length: 64 }, (_, l) => [`label${l}`, `${n}`.repeat(1_000)])),
  );
  const note = (key: string, alerts: Record<string, string>[], minute: number) =>
    incidentRepository(deps.db).noteSignal(
      acme,
      id,
      { key, integrationId: integration, title: "DiskFull", status: "firing", alerts },
      new Date(Date.UTC(2026, 10, 8, 15, minute)),
    );
  await note("many", many, 0);
  await note("huge", huge, 1);
  await note("after", many.slice(0, 1), 2);

  const timeline = (await evidence(id)).timeline.flatMap((e) =>
    e.kind === "signal" ? [{ shown: e.alerts.length, of: e.alertCount }] : [],
  );

  // The first 20 of 25; then no labels once a note would pass the room for them.
  expect(timeline).toEqual([
    { shown: 20, of: 25 },
    { shown: 0, of: 20 },
    { shown: 0, of: 1 },
  ]);
});

test("a manual incident shows its status changes and every notice sent about it", async () => {
  const created = await owner.call("/v1/incidents", {
    title: "Slow logins",
    impact: "minor",
    body: "Logins are slow for some people.",
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { id: IncidentId }).id;
  await owner.call(`/v1/incidents/${id}/updates`, {
    status: "resolved",
    body: "Logins are fast again.",
  });

  const [ann, bob, cat] = [
    subscriberId.parse(v7()),
    subscriberId.parse(v7()),
    subscriberId.parse(v7()),
  ];
  await deps.db.insert(schema.subscriber).values(
    [ann, bob, cat].map((subscriber, i) => ({
      id: subscriber,
      workspaceId: acme,
      email: `person${i}@example.com`,
      state: "active" as const,
    })),
  );
  const endpoint = webhookEndpointId.parse(v7());
  await deps.db.insert(schema.webhookEndpoint).values({
    id: endpoint,
    workspaceId: acme,
    kind: "slack",
    name: "#incidents",
    urlSealed: "sealed",
  });
  const opened = eventId.parse(v7());
  const closed = eventId.parse(v7());
  const delivery = (
    event: EventId,
    minute: number,
    target: { subscriberId: SubscriberId } | { endpointId: WebhookEndpointId },
    status: DeliveryStatus,
    extra: { lastError?: string; sentAt?: Date; attempts?: number } = {},
  ): typeof schema.delivery.$inferInsert => ({
    id: deliveryId.parse(v7()),
    workspaceId: acme,
    eventId: event,
    subjectId: id,
    channel: "subscriberId" in target ? "email" : "slack",
    status,
    createdAt: new Date(Date.UTC(2026, 10, 8, 14, minute)),
    ...target,
    ...extra,
  });
  await deps.db.insert(schema.delivery).values([
    delivery(opened, 0, { subscriberId: ann }, "sent"),
    delivery(opened, 1, { subscriberId: bob }, "sent"),
    delivery(opened, 1, { subscriberId: cat }, "failed", { lastError: "Bounced." }),
    delivery(opened, 2, { endpointId: endpoint }, "sent", {
      sentAt: new Date(Date.UTC(2026, 10, 8, 14, 2, 5)),
      attempts: 1,
    }),
    delivery(closed, 30, { subscriberId: ann }, "pending"),
    delivery(closed, 30, { endpointId: endpoint }, "failed", {
      lastError: "The endpoint answered HTTP 503.",
      attempts: 3,
    }),
  ]);

  const shown = await evidence(id);

  expect(shown.monitor).toBeNull();
  expect(shown.timeline.map((e) => e.kind === "status_changed" && [e.from, e.to])).toEqual([
    [null, "investigating"],
    ["investigating", "resolved"],
  ]);
  expect(shown.notifications).toEqual([
    {
      eventId: opened,
      at: "2026-11-08T14:00:00.000Z",
      subscribers: { pending: 0, sent: 2, failed: 1, skipped: 0 },
      endpoints: [
        {
          id: endpoint,
          name: "#incidents",
          kind: "slack",
          status: "sent",
          attempts: 1,
          lastError: null,
          sentAt: "2026-11-08T14:02:05.000Z",
        },
      ],
    },
    {
      eventId: closed,
      at: "2026-11-08T14:30:00.000Z",
      subscribers: { pending: 1, sent: 0, failed: 0, skipped: 0 },
      endpoints: [
        {
          id: endpoint,
          name: "#incidents",
          kind: "slack",
          status: "failed",
          attempts: 3,
          lastError: "The endpoint answered HTTP 503.",
          sentAt: null,
        },
      ],
    },
  ]);

  // Destinations and subscribers are admin-only; a read-only key sees the rest.
  const { key } = (await (
    await owner.call("/v1/api-keys", { name: "Read", scope: "read" })
  ).json()) as {
    key: string;
  };
  const read = await owner.call(`/v1/incidents/${id}/evidence`, undefined, "GET", {
    authorization: `Bearer ${key}`,
    cookie: "",
  });
  expect(read.status).toBe(200);
  const seen = incidentEvidence.parse(await read.json());
  expect(seen.notifications).toBeNull();
  expect(seen.timeline).toEqual(shown.timeline);
});

test("another workspace's incident is not found", async () => {
  const other = workspaceId.parse(v7());
  await deps.db.insert(schema.workspace).values({ id: other, name: "Globex" });
  const id = incidentId.parse(v7());
  await deps.db.insert(schema.incident).values({
    id,
    workspaceId: other,
    title: "Theirs",
    status: "investigating",
    impact: "minor",
    startedAt: at("2026-11-08T10:00:00.000Z"),
  });
  await expectProblem(await owner.call(`/v1/incidents/${id}/evidence`), 404, "not_found");
});
