import {
  componentId,
  eventId,
  heartbeatDetection,
  type IncidentId,
  incidentId,
  incidentUpdateId,
  type MonitorState,
  monitorConfig,
  monitorId,
  type OutboxId,
  type PublishPolicy,
  workspaceId,
} from "@galena/contracts";
import {
  createDb,
  type Db,
  findOutboxRow,
  incidentRepository,
  monitorRepository,
  recordMonitorTransition,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  actOnTransition,
  type DraftDeadline,
  type DraftPayload,
  decideDraft,
  openIncident,
  settleDraft,
} from "./autopilot.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const NOW = new Date("2026-10-05T10:00:00.000Z");
const clock = { now: () => NOW };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

/** A monitor with the policy, on a component of its own unless `onComponent` is false. */
async function monitorWith(
  publishPolicy: PublishPolicy,
  onComponent = true,
  type: "http" | "heartbeat" = "http",
) {
  const component = componentId.parse(v7());
  const name = `Service ${component.slice(-4)}`;
  if (onComponent) {
    await db
      .insert(schema.component)
      .values({ id: component, workspaceId: acme, name, position: 0 });
  }
  const id = monitorId.parse(v7());
  await monitorRepository(db).save(
    monitorConfig.parse({
      id,
      workspaceId: acme,
      componentId: onComponent ? component : null,
      name,
      ...(type === "heartbeat"
        ? {
            type: "heartbeat",
            heartbeat: {
              periodMinutes: 60,
              graceMinutes: 5,
              tokenIssuedAt: "2026-10-05T08:00:00.000Z",
            },
            detection: heartbeatDetection,
          }
        : { type: "http", http: { url: "https://service.example.com/health" } }),
      publishPolicy,
    }),
  );
  return { id, component, name };
}

const transition = (
  monitor: string,
  to: MonitorState,
  seq: number,
  suppressed = false,
  from: MonitorState = "up",
) => ({
  id: eventId.parse(v7()),
  type: "monitor.transitioned" as const,
  occurredAt: NOW.toISOString(),
  workspaceId: acme,
  data: {
    monitorId: monitorId.parse(monitor),
    from,
    to,
    transitionSeq: seq,
    suppressed,
  },
});

/** Fake ports that record what the workflow handed on. */
function recorder() {
  const dispatched: OutboxId[] = [];
  const approvals: DraftDeadline[] = [];
  const backstops: OutboxId[] = [];
  return {
    dispatched,
    approvals,
    backstops,
    deps: {
      db,
      clock,
      backstop: async (id: OutboxId) => void backstops.push(id),
      dispatch: async (id: OutboxId) => void dispatched.push(id),
      armDraft: async (draft: DraftDeadline) => void approvals.push(draft),
    },
  };
}

const eventOf = async (id: OutboxId | undefined) =>
  id ? ((await findOutboxRow(db, id))?.payload as { type: string; data: unknown }) : undefined;

test("auto: a monitor going down publishes an incident at once, and a retry opens no second one", async () => {
  const monitor = await monitorWith("auto");
  const { deps, dispatched, approvals } = recorder();

  const first = await actOnTransition(transition(monitor.id, "down", 1), deps);
  expect(first).toMatchObject({ action: "open", created: true, visibility: "published" });
  const id = (first as { incidentId: IncidentId }).incidentId;
  expect(await incidentRepository(db).findById(acme, id)).toMatchObject({
    title: `${monitor.name} is down`,
    status: "investigating",
    visibility: "published",
    source: "monitor",
    approvalDeadline: null,
    components: [{ componentId: monitor.component, status: "major_outage" }],
  });
  expect(await eventOf(dispatched[0])).toMatchObject({
    type: "incident.created",
    data: { incidentId: id, visibility: "published" },
  });
  expect(approvals).toEqual([]);

  // The same transition again (a retried run) finds the incident it opened.
  const again = await actOnTransition(transition(monitor.id, "down", 1), deps);
  expect(again).toMatchObject({ action: "attach", incidentId: id });
  expect(dispatched).toHaveLength(1);
});

test("a dispatch that fails after the incident opened leaves its row to the backstop", async () => {
  const monitor = await monitorWith("auto");
  const { deps, dispatched, backstops } = recorder();
  const unreachable = async () => {
    throw new Error("queue unreachable");
  };

  await expect(
    actOnTransition(transition(monitor.id, "down", 1), { ...deps, dispatch: unreachable }),
  ).rejects.toThrow("queue unreachable");
  // Its retry finds the incident open and dispatches nothing; the backstop armed before the
  // transaction names the row it wrote.
  await actOnTransition(transition(monitor.id, "down", 1), deps);
  expect(dispatched).toEqual([]);
  expect(await eventOf(backstops[0])).toMatchObject({ type: "incident.created" });
});

test.each([
  ["down", "published"],
  ["recovering", "dismissed"],
] as const)(
  "approve: unanswered at its deadline while the monitor is %s, the draft is %s",
  async (state, outcome) => {
    const monitor = await monitorWith("approve");
    const { deps, dispatched, approvals } = recorder();

    const opened = await actOnTransition(transition(monitor.id, "down", 1), deps);
    expect(opened).toMatchObject({ action: "open", created: true, visibility: "draft" });
    const id = (opened as { incidentId: IncidentId }).incidentId;
    expect(approvals).toEqual([
      {
        workspaceId: acme,
        incidentId: id,
        monitorId: monitor.id,
        deadline: new Date("2026-10-05T10:10:00.000Z"),
      },
    ]);
    expect(await incidentRepository(db).findById(acme, id)).toMatchObject({
      visibility: "draft",
      approvalDeadline: new Date("2026-10-05T10:10:00.000Z"),
    });

    // Where the monitor stands when the deadline comes.
    await recordMonitorTransition(db, {
      workspaceId: acme,
      monitorId: monitor.id,
      from: "down",
      to: state,
      seq: 2,
      at: NOW,
    });
    const { deadline: _, ...draft } = approvals[0] as DraftDeadline;
    const settled = await settleDraft(draft, deps);
    expect(settled).toBe(outcome);
    expect(await incidentRepository(db).findById(acme, id)).toMatchObject({
      visibility: outcome,
      approvalDeadline: null,
    });
    expect(await eventOf(dispatched[1])).toMatchObject({
      type: "incident.updated",
      data: { incidentId: id, visibility: outcome },
    });
  },
);

test.each(["published", "dismissed"] as const)(
  "a draft a person %s before its deadline keeps their answer when the deadline comes",
  async (answer) => {
    const monitor = await monitorWith("approve");
    const { deps, approvals } = recorder();
    await actOnTransition(transition(monitor.id, "down", 1), deps);
    const { deadline: _, ...draft } = approvals[0] as DraftDeadline;
    await decideDraft({ ...draft, visibility: answer, actorUserId: null }, deps);

    expect(await settleDraft(draft, deps)).toBe("decided_elsewhere");
    expect(await incidentRepository(db).findById(acme, draft.incidentId)).toMatchObject({
      visibility: answer,
    });
  },
);

test("a dismissed draft frees the monitor to draft again when it next goes down", async () => {
  const monitor = await monitorWith("approve");
  const { deps, approvals } = recorder();
  await actOnTransition(transition(monitor.id, "down", 1), deps);
  const first = approvals[0] as DraftDeadline;
  await decideDraft(
    { workspaceId: acme, incidentId: first.incidentId, visibility: "dismissed", actorUserId: null },
    deps,
  );

  const next = await actOnTransition(transition(monitor.id, "down", 3), deps);
  expect(next).toMatchObject({ action: "open", created: true, visibility: "draft" });
  expect((next as { incidentId: IncidentId }).incidentId).not.toBe(approvals[0]?.incidentId);
});

test("an open that loses a race arms the draft's own deadline, and nothing once it is decided", async () => {
  const monitor = await monitorWith("approve");
  const { deps, approvals } = recorder();
  const plan = (approvalDeadline: Date) => ({
    action: "open" as const,
    dedupKey: `mon:${monitor.id}`,
    visibility: "draft" as const,
    title: `${monitor.name} is down`,
    body: "We're looking into it.",
    impact: "major" as const,
    components: [{ componentId: monitor.component, status: "major_outage" as const }],
    approvalDeadline,
  });
  const opener = { source: "monitor" as const, monitorId: monitor.id };
  const first = new Date("2026-10-05T10:10:00.000Z");
  await openIncident(acme, plan(first), opener, NOW, deps);

  // A second run for the same monitor, planned three minutes later, finds the draft opened.
  const later = plan(new Date("2026-10-05T10:13:00.000Z"));
  expect(await openIncident(acme, later, opener, NOW, deps)).toMatchObject({ created: false });
  expect(approvals.map((a) => a.deadline)).toEqual([first, first]);

  const { incidentId: id } = approvals[0] as DraftPayload;
  await decideDraft(
    { workspaceId: acme, incidentId: id, visibility: "published", actorUserId: null },
    deps,
  );
  await openIncident(acme, later, opener, NOW, deps);
  expect(approvals).toHaveLength(2);
});

test("a transition older than the monitor's last one opens nothing", async () => {
  const monitor = await monitorWith("auto");
  const { deps, dispatched } = recorder();
  // Recovery (6) is recorded; the down that came before it (5) arrives late.
  await recordMonitorTransition(db, {
    workspaceId: acme,
    monitorId: monitor.id,
    from: "down",
    to: "up",
    seq: 6,
    at: NOW,
  });
  expect(await actOnTransition(transition(monitor.id, "down", 5), deps)).toEqual({
    action: "none",
    reason: "stale",
  });
  expect(dispatched).toEqual([]);
});

test("an open incident on the component takes the monitor; no second incident opens", async () => {
  const monitor = await monitorWith("auto");
  const manual = incidentId.parse(v7());
  await incidentRepository(db).create(
    {
      id: manual,
      workspaceId: acme,
      title: "Slow responses",
      impact: "minor",
      visibility: "published",
      source: "manual",
      startedAt: NOW,
    },
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "investigating",
        body: "Looking into it.",
        createdAt: NOW,
        createdByUserId: null,
      },
      stage: { status: "investigating", resolvedAt: null },
      components: [{ componentId: monitor.component, status: "degraded_performance" }],
    },
  );
  const { deps, dispatched } = recorder();
  expect(await actOnTransition(transition(monitor.id, "down", 1), deps)).toEqual({
    action: "attach",
    incidentId: manual,
  });
  expect(dispatched).toEqual([]);
});

test.each([
  ["an internal-only monitor", "internal_only", true, false, "internal_only"],
  ["a monitor on no component", "approve", false, false, "no_component"],
  ["a transition inside a maintenance window", "auto", true, true, "suppressed"],
] as const)("%s opens nothing", async (_, policy, onComponent, suppressed, reason) => {
  const monitor = await monitorWith(policy, onComponent);
  const { deps, dispatched, approvals } = recorder();
  expect(await actOnTransition(transition(monitor.id, "down", 1, suppressed), deps)).toEqual({
    action: "none",
    reason,
  });
  expect([dispatched, approvals]).toEqual([[], []]);
});

test("its incident goes Monitoring on recovery, Investigating if it fails again, and resolves once up", async () => {
  const monitor = await monitorWith("auto");
  const { deps, dispatched } = recorder();
  const steps = [
    ["up", "down"],
    ["down", "recovering"],
    ["recovering", "down"],
    ["down", "recovering"],
    ["recovering", "up"],
  ] as const;
  let id: IncidentId | undefined;
  for (const [i, [from, to]] of steps.entries()) {
    const done = await actOnTransition(transition(monitor.id, to, i + 1, false, from), deps);
    if (done.action === "open") id = done.incidentId;
  }
  if (!id) throw new Error("nothing opened");

  const resolved = await incidentRepository(db).findById(acme, id);
  expect(resolved?.status).toBe("resolved");
  expect(resolved?.resolvedAt).toEqual(NOW);
  expect(resolved?.updates.map((u) => u.status).reverse()).toEqual([
    "investigating",
    "monitoring",
    "investigating",
    "monitoring",
    "resolved",
  ]);
  const events = await Promise.all(dispatched.map(eventOf));
  expect(events.map((e) => e?.type)).toEqual([
    "incident.created",
    "incident.updated",
    "incident.updated",
    "incident.updated",
    "incident.resolved",
  ]);

  // Up again later changes nothing: it has no open incident of its own any more.
  expect(await actOnTransition(transition(monitor.id, "up", 6), deps)).toEqual({
    action: "none",
    reason: "no_incident",
  });
});

test("a missed heartbeat opens a draft in its own words, and the next check-in resolves it", async () => {
  const monitor = await monitorWith("approve", true, "heartbeat");
  const { deps, approvals } = recorder();

  // The transitions the sweeper triggers: up → down for the missed window, then down → up.
  const missed = await actOnTransition(transition(monitor.id, "down", 2), deps);
  expect(missed).toMatchObject({ action: "open", created: true, visibility: "draft" });
  const id = (missed as { incidentId: IncidentId }).incidentId;
  expect(approvals).toHaveLength(1);
  const draft = await incidentRepository(db).findById(acme, id);
  expect(draft).toMatchObject({ visibility: "draft", status: "investigating", source: "monitor" });
  expect(draft?.updates.map((u) => u.body)).toEqual([
    `${monitor.name} is running behind schedule. We're investigating and will update by 10:30 UTC.`,
  ]);

  const back = await actOnTransition(transition(monitor.id, "up", 3, false, "down"), deps);
  expect(back).toMatchObject({ action: "update", status: "resolved" });
  const resolved = await incidentRepository(db).findById(acme, id);
  expect(resolved?.status).toBe("resolved");
  expect(resolved?.updates[0]?.body).toBe(
    `${monitor.name} has worked normally since 10:00 UTC. It is running on schedule again.`,
  );
});
