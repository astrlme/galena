import {
  componentId,
  eventId,
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
import { type DraftPayload, draftFromTransition, settleDraft } from "./autopilot.ts";

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
async function monitorWith(publishPolicy: PublishPolicy, onComponent = true) {
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
      type: "http",
      http: { url: "https://service.example.com/health" },
      publishPolicy,
    }),
  );
  return { id, component, name };
}

const transition = (monitor: string, to: MonitorState, seq: number, suppressed = false) => ({
  id: eventId.parse(v7()),
  type: "monitor.transitioned" as const,
  occurredAt: NOW.toISOString(),
  workspaceId: acme,
  data: {
    monitorId: monitorId.parse(monitor),
    from: "up" as const,
    to,
    transitionSeq: seq,
    suppressed,
  },
});

/** Fake ports that record what the workflow handed on. */
function recorder() {
  const dispatched: OutboxId[] = [];
  const approvals: DraftPayload[] = [];
  return {
    dispatched,
    approvals,
    deps: {
      db,
      clock,
      dispatch: async (id: OutboxId) => void dispatched.push(id),
      awaitApproval: async (draft: DraftPayload) => void approvals.push(draft),
    },
  };
}

const eventOf = async (id: OutboxId | undefined) =>
  id ? ((await findOutboxRow(db, id))?.payload as { type: string; data: unknown }) : undefined;

test("auto: a monitor going down publishes an incident at once, and a retry opens no second one", async () => {
  const monitor = await monitorWith("auto");
  const { deps, dispatched, approvals } = recorder();

  const first = await draftFromTransition(transition(monitor.id, "down", 1), deps);
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
  const again = await draftFromTransition(transition(monitor.id, "down", 1), deps);
  expect(again).toMatchObject({ action: "attach", incidentId: id });
  expect(dispatched).toHaveLength(1);
});

test.each([
  ["approved", "up", "published"],
  ["dismissed", "down", "dismissed"],
  ["timed_out", "down", "published"],
  ["timed_out", "recovering", "dismissed"],
] as const)(
  "approve: answered %s while the monitor is %s, the draft is %s",
  async (answer, state, outcome) => {
    const monitor = await monitorWith("approve");
    const { deps, dispatched, approvals } = recorder();

    const opened = await draftFromTransition(transition(monitor.id, "down", 1), deps);
    expect(opened).toMatchObject({ action: "open", created: true, visibility: "draft" });
    const id = (opened as { incidentId: IncidentId }).incidentId;
    expect(approvals).toEqual([{ workspaceId: acme, incidentId: id, monitorId: monitor.id }]);
    expect(await incidentRepository(db).findById(acme, id)).toMatchObject({
      visibility: "draft",
      approvalDeadline: new Date("2026-10-05T10:10:00.000Z"),
    });

    // Where the monitor stands when the answer, or the deadline, comes.
    await recordMonitorTransition(db, {
      workspaceId: acme,
      monitorId: monitor.id,
      from: "down",
      to: state,
      seq: 2,
      at: NOW,
    });
    const deadlines: Date[] = [];
    const settled = await settleDraft(approvals[0] as DraftPayload, {
      db,
      clock,
      dispatch: deps.dispatch,
      waitForAnswer: async ({ deadline }) => {
        deadlines.push(deadline);
        return answer;
      },
    });
    expect(settled).toBe(outcome);
    expect(deadlines).toEqual([new Date("2026-10-05T10:10:00.000Z")]);
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

test("a draft someone already decided is left alone, without waiting", async () => {
  const monitor = await monitorWith("approve");
  const { deps, approvals } = recorder();
  await draftFromTransition(transition(monitor.id, "down", 1), deps);
  const draft = approvals[0] as DraftPayload;
  await incidentRepository(db).decide(acme, draft.incidentId, "published");
  let waited = false;
  const settled = await settleDraft(draft, {
    ...deps,
    waitForAnswer: async () => {
      waited = true;
      return "timed_out";
    },
  });
  expect([settled, waited]).toEqual(["decided_elsewhere", false]);
});

test("a dismissed draft frees the monitor to draft again when it next goes down", async () => {
  const monitor = await monitorWith("approve");
  const { deps, approvals } = recorder();
  await draftFromTransition(transition(monitor.id, "down", 1), deps);
  await settleDraft(approvals[0] as DraftPayload, {
    ...deps,
    waitForAnswer: async () => "dismissed",
  });

  const next = await draftFromTransition(transition(monitor.id, "down", 3), deps);
  expect(next).toMatchObject({ action: "open", created: true, visibility: "draft" });
  expect((next as { incidentId: IncidentId }).incidentId).not.toBe(approvals[0]?.incidentId);
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
  expect(await draftFromTransition(transition(monitor.id, "down", 1), deps)).toEqual({
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
  expect(await draftFromTransition(transition(monitor.id, "down", 1, suppressed), deps)).toEqual({
    action: "none",
    reason,
  });
  expect([dispatched, approvals]).toEqual([[], []]);
});
