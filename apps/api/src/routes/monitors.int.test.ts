import { type IncidentId, type MonitorId, monitorChanged, type OutboxId } from "@galena/contracts";
import type { MinuteCounts } from "@galena/core";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import type { MonitorReading, PointAt } from "../telemetry.ts";
import { type Triggered, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

type View = {
  id: string;
  name: string;
  componentId: string | null;
  enabled: boolean;
  publishPolicy: string;
  http: { url: string; method: string; keyword?: string };
  detection: { quorum: number; failThreshold: number };
};

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let readings: Map<MonitorId, MonitorReading>;
let points: Map<MonitorId, PointAt[]>;
let months: Map<string, MinuteCounts>;
let owner: Session;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
  readings = built.readings;
  points = built.points;
  months = built.months;
  close = built.close;
  owner = new Session(createApp(deps));
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(setup.status).toBe(201);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const list = async () =>
  ((await (await owner.call("/v1/monitors")).json()) as { monitors: View[] }).monitors;
const create = async (body: unknown) => {
  const response = await owner.call("/v1/monitors", body);
  expect(response.status).toBe(201);
  return (await response.json()) as View;
};

test("an editor adds a monitor; omitted settings take their documented defaults", async () => {
  const created = await create({ name: "API", http: { url: "https://api.example.com/health" } });
  expect(created).toMatchObject({
    componentId: null,
    enabled: true,
    publishPolicy: "approve",
    http: { url: "https://api.example.com/health", method: "GET" },
    detection: { quorum: 2, failThreshold: 2 },
  });
  expect((await list()).map((m) => m.id)).toEqual([created.id]);
});

test.each([
  ["a private address", "http://10.0.0.8/health", 422, "url_refused"],
  ["the instance metadata service", "http://169.254.169.254/latest/", 422, "url_refused"],
  ["loopback", "http://127.0.0.1:8080/", 422, "url_refused"],
  ["a file URL", "file:///etc/passwd", 400, "validation_failed"],
  ["credentials in the URL", "https://ada:secret@example.com/", 400, "validation_failed"],
])("refuses %s", async (_, url, status, code) => {
  await expectProblem(
    await owner.call("/v1/monitors", { name: "Bad", http: { url } }),
    status,
    code,
  );
});

test("refuses a component that does not exist", async () => {
  const body = { name: "Ghost", componentId: v7(), http: { url: "https://example.com/" } };
  await expectProblem(await owner.call("/v1/monitors", body), 422, "component_not_found");
});

test("PUT replaces every setting and answers 404 for an unknown monitor", async () => {
  const [api] = await list();
  const body = {
    name: "Public API",
    enabled: false,
    publishPolicy: "internal_only",
    http: { url: "https://api.example.com/health", keyword: "ok" },
  };
  const response = await owner.call(`/v1/monitors/${api?.id}`, body, "PUT");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ...body, http: { ...body.http, method: "GET" } });
  expect((await list())[0]).toMatchObject({ name: "Public API", enabled: false });
  await expectProblem(await owner.call(`/v1/monitors/${v7()}`, body, "PUT"), 404, "not_found");
});

test("deletes a monitor, then answers 404 for it", async () => {
  const doomed = await create({ name: "Doomed", http: { url: "https://example.com/" } });
  expect((await owner.call(`/v1/monitors/${doomed.id}`, undefined, "DELETE")).status).toBe(204);
  await expectProblem(
    await owner.call(`/v1/monitors/${doomed.id}`, undefined, "DELETE"),
    404,
    "not_found",
  );
});

test("every change leaves an audit entry and a monitor.changed outbox event", async () => {
  const audit = await deps.db.select().from(schema.auditLog);
  const events = await deps.db.select().from(schema.outbox);
  expect(audit.map((a) => a.action)).toEqual([
    "monitor.created",
    "monitor.updated",
    "monitor.created",
    "monitor.deleted",
  ]);
  expect(events).toHaveLength(audit.length);
  for (const { payload } of events) expect(monitorChanged.safeParse(payload).success).toBe(true);
});

test("each change hands its outbox row to outbox.dispatch once it has committed", async () => {
  const created = await create({ name: "Dispatched", http: { url: "https://example.com/" } });
  const last = triggered.at(-1);
  if (!last) throw new Error("The change triggered nothing.");
  expect(last.task).toBe("outbox.dispatch");
  const { outboxId } = last.payload as { outboxId: OutboxId };
  expect(last.idempotencyKey).toBe(`outbox:${outboxId}`);
  const [row] = await deps.db.select().from(schema.outbox).where(eq(schema.outbox.id, outboxId));
  expect(row?.payload).toMatchObject({ type: "monitor.changed", data: { ids: [created.id] } });
});

test("a change arms a delayed dispatch first, so a crash after the commit still delivers", async () => {
  const seen: (Triggered & { rowExisted: boolean })[] = [];
  const crashing: Deps = {
    ...deps,
    engine: {
      async trigger(task, payload, { idempotencyKey, at }) {
        const { outboxId } = payload as { outboxId: OutboxId };
        const rows = await deps.db
          .select({ id: schema.outbox.id })
          .from(schema.outbox)
          .where(eq(schema.outbox.id, outboxId));
        const rowExisted = rows.length === 1;
        seen.push({ task, payload, idempotencyKey, rowExisted, ...(at ? { at } : {}) });
        // The process dies after the commit, before the undelayed trigger reaches the queue.
        if (!at) throw new Error("Task timed out after 29.03 seconds");
      },
    },
  };
  const session = new Session(createApp(crashing));
  await session.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  const sent = Date.now();
  const response = await session.call("/v1/monitors", {
    name: "Crashed",
    http: { url: "https://example.com/crashed" },
  });
  expect(response.status).toBe(201);
  const [backstop, afterCommit] = seen;
  if (!backstop) throw new Error("Nothing was triggered.");
  const { outboxId } = backstop.payload as { outboxId: OutboxId };
  expect(backstop).toMatchObject({
    task: "outbox.dispatch",
    idempotencyKey: `outbox:${outboxId}:backstop`,
    rowExisted: false,
  });
  const wait = (backstop.at?.getTime() ?? 0) - sent;
  expect(wait).toBeGreaterThanOrEqual(60_000);
  expect(wait).toBeLessThan(70_000);
  expect(afterCommit).toMatchObject({ idempotencyKey: `outbox:${outboxId}`, rowExisted: true });
  // The delayed run finds this committed, still pending row and dispatches it.
  const [row] = await deps.db.select().from(schema.outbox).where(eq(schema.outbox.id, outboxId));
  expect(row).toMatchObject({ eventType: "monitor.changed", dispatchedAt: null });
});

test("a change still succeeds when the job queue is unreachable", async () => {
  const unreachable: Deps = {
    ...deps,
    engine: {
      trigger: async () => {
        throw new Error("fetch failed");
      },
    },
  };
  const session = new Session(createApp(unreachable));
  await session.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  const response = await session.call("/v1/monitors", {
    name: "Offline",
    http: { url: "https://example.com/offline" },
  });
  expect(response.status).toBe(201);
  const pending = await deps.db
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.eventType, "monitor.changed"));
  expect(pending.at(-1)?.dispatchedAt).toBeNull();
});

test("telemetry maps each monitor's state to a status and passes its results and summary on", async () => {
  const down = await create({
    name: "Checkout",
    downStatus: "partial_outage",
    http: { url: "https://checkout.example.com/health" },
  });
  const quiet = await create({ name: "Quiet", http: { url: "https://quiet.example.com/" } });
  const results = [
    {
      region: "eu-west-1",
      scheduledAt: "2026-09-28T17:33:00.000Z",
      status: "down",
      latencyMs: null,
    },
    { region: "eu-west-3", scheduledAt: "2026-09-28T17:33:00.000Z", status: "up", latencyMs: 85 },
  ] as const;
  const summary = {
    through: "2026-09-28T16",
    hourlyMedianMs: [...Array.from({ length: 23 }, () => null), 120],
    p95Ms: 180,
    minutes: 1440,
    minutesDown: 2,
  };
  readings.set(down.id as MonitorId, {
    state: "down",
    enteredAt: Date.parse("2026-09-28T17:30:00.000Z"),
    results: [...results],
    summary,
  });

  const response = await owner.call("/v1/monitors/telemetry?minutes=5");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    regions: string[];
    monitors: { id: string; state: string; status: string | null; since: string | null }[];
  };
  expect(body.regions).toEqual(["eu-west-1", "eu-west-3", "eu-north-1"]);
  expect(body.monitors.find((m) => m.id === down.id)).toEqual({
    id: down.id,
    state: "down",
    status: "partial_outage",
    since: "2026-09-28T17:30:00.000Z",
    results,
    summary,
  });
  // No state item yet: detection has no opinion, so there is no status either.
  expect(body.monitors.find((m) => m.id === quiet.id)).toEqual({
    id: quiet.id,
    state: "unknown",
    status: null,
    since: null,
    results: [],
    summary: null,
  });
  expect((await owner.call("/v1/monitors/telemetry?minutes=0")).status).toBe(400);
});

const point = (at: string, region: string): PointAt => ({
  at,
  region,
  checks: 60,
  down: 0,
  medianMs: 120,
  p95Ms: 180,
  maxMs: 240,
  phases: { dns: 5, connect: 10, tls: 20, ttfb: 100 },
});

test("a monitor's chart comes oldest first, then by region; an unknown monitor is a 404", async () => {
  const charted = await create({ name: "Charted", http: { url: "https://chart.example.com/" } });
  points.set(charted.id as MonitorId, [
    point("2026-11-02T12", "eu-west-3"),
    point("2026-11-02T11", "eu-west-1"),
    point("2026-11-02T12", "eu-west-1"),
  ]);
  const response = await owner.call(`/v1/monitors/${charted.id}/series?range=7d`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { range: string; step: string; points: PointAt[] };
  expect(body).toMatchObject({ range: "7d", step: "hour" });
  expect(body.points.map((p) => `${p.at} ${p.region}`)).toEqual([
    "2026-11-02T11 eu-west-1",
    "2026-11-02T12 eu-west-1",
    "2026-11-02T12 eu-west-3",
  ]);
  await expectProblem(await owner.call(`/v1/monitors/${v7()}/series?range=24h`), 404, "not_found");
  expect((await owner.call(`/v1/monitors/${charted.id}/series?range=1y`)).status).toBe(400);
});

test("a monitor's month says its minutes down and the incidents it opened, nobody else's", async () => {
  const watched = await create({ name: "Watched", http: { url: "https://month.example.com/" } });
  const other = await create({ name: "Other", http: { url: "https://other.example.com/" } });
  months.set(`${watched.id} 2026-10`, { minutes: 44_640, down: 12 });
  const [ws] = await deps.db.select().from(schema.workspace);
  const incident = (monitor: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
    id: v7() as IncidentId,
    workspaceId: ws?.id ?? expect.fail("no workspace"),
    title: "Down",
    status: "resolved" as const,
    impact: "major" as const,
    source: "monitor" as const,
    dedupKey: `mon:${monitor}`,
    startedAt: new Date(startedAt),
    // Resolved: only one open incident per monitor may exist at a time.
    resolvedAt: new Date(Date.parse(startedAt) + 3_600_000),
    ...extra,
  });
  await deps.db.insert(schema.incident).values([
    incident(watched.id, "2026-10-03T10:00:00.000Z"),
    incident(watched.id, "2026-10-31T23:59:00.000Z"),
    // Not counted: a dismissed draft, a deleted incident, November, another monitor.
    incident(watched.id, "2026-10-10T10:00:00.000Z", { visibility: "dismissed" }),
    incident(watched.id, "2026-10-11T10:00:00.000Z", { deletedAt: new Date() }),
    incident(watched.id, "2026-11-01T00:00:00.000Z"),
    incident(other.id, "2026-10-05T10:00:00.000Z"),
  ]);
  const response = await owner.call(`/v1/monitors/${watched.id}/uptime?month=2026-10`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    month: "2026-10",
    minutes: 44_640,
    minutesDown: 12,
    incidents: 2,
  });
  expect((await owner.call(`/v1/monitors/${watched.id}/uptime?month=2026-13`)).status).toBe(400);
});

test("pauses two monitors in one change, and refuses a list with someone else's monitor", async () => {
  const first = await create({ name: "Bulk one", http: { url: "https://one.example.com/" } });
  const second = await create({ name: "Bulk two", http: { url: "https://two.example.com/" } });
  const kept = await create({ name: "Bulk kept", http: { url: "https://kept.example.com/" } });
  const before = (await deps.db.select().from(schema.auditLog)).length;

  const response = await owner.call(
    "/v1/monitors",
    { ids: [first.id, second.id], enabled: false },
    "PATCH",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { monitors: { id: string; enabled: boolean }[] };
  expect(body.monitors.map((m) => [m.id, m.enabled])).toEqual([
    [first.id, false],
    [second.id, false],
  ]);
  const enabled = new Map((await list()).map((m) => [m.id, m.enabled]));
  expect([enabled.get(first.id), enabled.get(second.id), enabled.get(kept.id)]).toEqual([
    false,
    false,
    true,
  ]);
  // One audit entry and one outbox event name both monitors.
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit).toHaveLength(before + 1);
  expect(audit.at(-1)).toMatchObject({ action: "monitor.updated", targetId: null });

  await expectProblem(
    await owner.call("/v1/monitors", { ids: [kept.id, v7()], enabled: false }, "PATCH"),
    404,
    "not_found",
  );
  expect((await list()).find((m) => m.id === kept.id)?.enabled).toBe(true);
  expect((await owner.call("/v1/monitors", { ids: [], enabled: false }, "PATCH")).status).toBe(400);
});

test("a viewer may list but not change monitors", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "viewer" })
    .where(eq(schema.member.role, "owner"));
  expect((await owner.call("/v1/monitors")).status).toBe(200);
  expect((await owner.call("/v1/monitors/telemetry")).status).toBe(200);
  await expectProblem(
    await owner.call("/v1/monitors", { name: "Nope", http: { url: "https://example.com/" } }),
    403,
    "forbidden",
  );
  await expectProblem(
    await owner.call("/v1/monitors", { ids: [v7()], enabled: false }, "PATCH"),
    403,
    "forbidden",
  );
});
