import { readFileSync } from "node:fs";
import {
  componentId,
  type IntegrationId,
  incidentId,
  incidentUpdateId,
  integrationId,
  maintenanceId,
  type OutboxId,
  type PublishPolicy,
  workspaceId,
} from "@galena/contracts";
import {
  createDb,
  createIntegration,
  type Db,
  findIntegration,
  findOutboxRow,
  incidentRepository,
  maintenanceRepository,
  schema,
} from "@galena/db";
import { readSignals } from "@galena/integrations/signals";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type DraftDeadline, type DraftPayload, settleDraft } from "./autopilot.ts";
import { actOnSignal } from "./signals.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const NOW = new Date("2026-10-13T10:05:00.000Z");
const ISSUED = new Date("2026-10-13T09:00:00.000Z");
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

type Notification = "firing" | "partly-resolved" | "resolved";
const fixture = (name: Notification): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../packages/integrations/test/fixtures/alertmanager/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

/** An Alertmanager integration routing `service=api` (or `match`) to a component of its own. */
async function integrationWith(publishPolicy: PublishPolicy, match = { service: "api" }) {
  const component = componentId.parse(v7());
  const name = `Service ${component.slice(-4)}`;
  await db.insert(schema.component).values({ id: component, workspaceId: acme, name, position: 0 });
  const id = integrationId.parse(v7());
  await createIntegration(db, {
    id,
    workspaceId: acme,
    source: "alertmanager",
    name: "Prometheus",
    publishPolicy,
    routes: [{ match, componentIds: [component], downStatus: "major_outage" }],
    tokenIssuedAt: ISSUED,
  });
  return { id, component, name };
}

/** Fake ports that record what the workflow handed on. */
function recorder() {
  const dispatched: OutboxId[] = [];
  const approvals: DraftDeadline[] = [];
  return {
    dispatched,
    approvals,
    deps: {
      db,
      clock,
      dispatch: async (id: OutboxId) => void dispatched.push(id),
      armDraft: async (draft: DraftDeadline) => void approvals.push(draft),
    },
  };
}

/** One Alertmanager notification (a fixture, or a body), read as the API reads it, handed on. */
function send(
  integration: IntegrationId,
  body: Notification | object,
  deps: ReturnType<typeof recorder>["deps"],
  issued = ISSUED,
) {
  const [signal] =
    readSignals("alertmanager", typeof body === "string" ? fixture(body) : body) ?? [];
  if (!signal) throw new Error("The body reads as no signal.");
  return actOnSignal(
    { integrationId: integration, tokenIssuedAt: issued.toISOString(), signal },
    deps,
  );
}

/** The incident's timeline notes about alert groups. */
const notes = async (id: string) =>
  (await db.select().from(schema.timelineEvent)).filter(
    (e) => e.incidentId === id && e.kind === "signal",
  );

test("approve: one firing group opens one draft, repeats change nothing, and its resolve message resolves it", async () => {
  const integration = await integrationWith("approve");
  const { deps, dispatched, approvals } = recorder();

  const opened = await send(integration.id, "firing", deps);
  expect(opened).toMatchObject({ action: "open", outcome: "opened" });
  const id = incidentId.parse(opened.incidentId);
  expect(await incidentRepository(db).findById(acme, id)).toMatchObject({
    title: `${integration.name} is down`,
    status: "investigating",
    visibility: "draft",
    source: "signal",
    approvalDeadline: new Date("2026-10-13T10:15:00.000Z"),
    components: [{ componentId: integration.component, status: "major_outage" }],
  });
  expect(approvals).toEqual([
    { workspaceId: acme, incidentId: id, deadline: new Date("2026-10-13T10:15:00.000Z") },
  ]);
  expect((await findOutboxRow(db, dispatched[0] as OutboxId))?.payload).toMatchObject({
    type: "incident.created",
    data: { incidentId: id, visibility: "draft" },
  });

  // Alertmanager repeats the group, and sends it again when one alert resolves.
  expect(await send(integration.id, "firing", deps)).toMatchObject({ outcome: "repeat" });
  expect(await send(integration.id, "partly-resolved", deps)).toMatchObject({ outcome: "repeat" });
  expect(approvals).toHaveLength(1);
  expect(dispatched).toHaveLength(1);

  expect(await send(integration.id, "resolved", deps)).toMatchObject({
    action: "update",
    outcome: "resolved",
    incidentId: id,
  });
  const resolved = await incidentRepository(db).findById(acme, id);
  expect(resolved).toMatchObject({ status: "resolved", visibility: "draft" });
  expect(resolved?.updates[0]?.body).toBe(
    `${integration.name} has worked normally since 10:05 UTC. Our alerts have cleared.`,
  );
  expect(await findIntegration(db, integration.id)).toMatchObject({
    lastOutcome: "resolved",
    lastSignalAt: NOW,
  });
  // The alert names and labels stay on the internal timeline, once when opened, once resolved.
  expect((await notes(id)).map((n) => (n.data as { status: string }).status)).toEqual([
    "firing",
    "resolved",
  ]);

  // Nobody answered, and the group resolved before the deadline: the draft is dismissed.
  const settled = await settleDraft(approvals[0] as DraftPayload, {
    db,
    clock,
    dispatch: deps.dispatch,
  });
  expect(settled).toBe("dismissed");
});

test("a firing group a person resolved stays quiet when the same notification comes again", async () => {
  const integration = await integrationWith("auto");
  const { deps, dispatched } = recorder();
  const opened = await send(integration.id, "firing", deps);
  expect(opened).toMatchObject({ action: "open", outcome: "opened" });
  // Someone resolves the incident in the dashboard while the alerts still fire.
  const resolved = await incidentRepository(db).append(
    acme,
    incidentId.parse(opened.incidentId),
    "investigating",
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "resolved",
        body: "Fixed on our side.",
        createdAt: NOW,
        createdByUserId: null,
      },
      stage: { status: "resolved", resolvedAt: NOW },
      statusChange: { from: "investigating", to: "resolved" },
    },
  );
  expect(resolved).toBe(true);

  // Alertmanager's repeat, hours later: the same notification, and no new incident.
  expect(await send(integration.id, "firing", deps)).toMatchObject({
    action: "none",
    outcome: "repeat",
  });
  expect(dispatched).toHaveLength(1);
});

test("approve: a group still firing at the deadline publishes its draft", async () => {
  const integration = await integrationWith("approve");
  const { deps, approvals } = recorder();
  await send(integration.id, "firing", deps);
  const settled = await settleDraft(approvals[0] as DraftPayload, {
    db,
    clock,
    dispatch: deps.dispatch,
  });
  expect(settled).toBe("published");
});

test("auto: a firing group publishes at once, with no approval", async () => {
  const integration = await integrationWith("auto");
  const { deps, approvals } = recorder();
  const opened = await send(integration.id, "firing", deps);
  expect(
    await incidentRepository(db).findById(acme, incidentId.parse(opened.incidentId)),
  ).toMatchObject({ visibility: "published", approvalDeadline: null });
  expect(approvals).toEqual([]);
});

test("no route, internal_only and maintenance open nothing, and the integration says why", async () => {
  const { deps, dispatched } = recorder();
  const unrouted = await integrationWith("approve", { service: "billing" });
  expect(await send(unrouted.id, "firing", deps)).toMatchObject({ outcome: "no_route" });
  const internal = await integrationWith("internal_only");
  expect(await send(internal.id, "firing", deps)).toMatchObject({ outcome: "internal_only" });

  const maintained = await integrationWith("auto");
  await maintenanceRepository(db).save(
    {
      id: maintenanceId.parse(v7()),
      workspaceId: acme,
      title: "Database upgrade",
      body: "",
      status: "in_progress",
      startsAt: new Date("2026-10-13T10:00:00Z"),
      endsAt: new Date("2026-10-13T11:00:00Z"),
      version: 1,
      cancelledAt: null,
      componentIds: [maintained.component],
    },
    null,
  );
  expect(await send(maintained.id, "firing", deps)).toMatchObject({ outcome: "suppressed" });
  expect(await findIntegration(db, maintained.id)).toMatchObject({ lastOutcome: "suppressed" });
  expect(dispatched).toEqual([]);
});

test("an incident already open on the component takes the group", async () => {
  const integration = await integrationWith("auto");
  const { deps } = recorder();
  const manual = incidentId.parse(v7());
  await incidentRepository(db).createOnce(
    {
      id: manual,
      workspaceId: acme,
      title: "Errors on the API",
      impact: "minor",
      visibility: "published",
      source: "manual",
      startedAt: NOW,
      dedupKey: `manual:${manual}`,
      approvalDeadline: null,
    },
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "investigating",
        body: "Looking.",
        createdAt: NOW,
        createdByUserId: null,
      },
      stage: { status: "investigating", resolvedAt: null },
      components: [{ componentId: integration.component, status: "partial_outage" }],
    },
  );
  expect(await send(integration.id, "firing", deps)).toMatchObject({
    action: "attach",
    outcome: "attached",
    incidentId: manual,
  });
  expect(await notes(manual)).toHaveLength(1);
});

test("an alert sent to a replaced URL is dropped without a trace", async () => {
  const integration = await integrationWith("auto");
  const { deps, dispatched } = recorder();
  const old = new Date("2026-10-12T09:00:00.000Z");
  expect(await send(integration.id, "firing", deps, old)).toEqual({
    action: "none",
    outcome: "revoked",
  });
  expect(dispatched).toEqual([]);
  expect(await findIntegration(db, integration.id)).toMatchObject({ lastOutcome: null });
});

test("a group a person dismissed stays dismissed while it fires, and opens afresh once it resolves", async () => {
  const integration = await integrationWith("approve");
  const { deps, approvals } = recorder();
  const opened = await send(integration.id, "firing", deps);
  const id = incidentId.parse(opened.incidentId);
  expect(await incidentRepository(db).decide(acme, id, "dismissed")).toBe(true);

  // Alertmanager leaves a resolved alert out of the next notification, so the group's earliest
  // start moves and a new run starts: it must not draft the group again.
  const firing = fixture("firing") as { alerts: { startsAt: string }[] };
  const moved = {
    ...firing,
    alerts: firing.alerts.filter((a) => !a.startsAt.startsWith("2026-10-13T10:01")),
  };
  expect(await send(integration.id, moved, deps)).toMatchObject({ outcome: "repeat" });
  expect(approvals).toHaveLength(1);

  expect(await send(integration.id, "resolved", deps)).toMatchObject({
    outcome: "resolved",
    incidentId: id,
  });
  // Firing again later: the alerts start anew, so the notification is a new one.
  const refired = {
    ...firing,
    alerts: firing.alerts.map((a) => ({ ...a, startsAt: "2026-10-13T12:00:00.000000000Z" })),
  };
  const again = await send(integration.id, refired, deps);
  expect(again).toMatchObject({ action: "open", outcome: "opened" });
  expect(again.incidentId).not.toBe(id);
  // The first notification itself, sent again, is a repeat.
  expect(await send(integration.id, "firing", deps)).toMatchObject({ outcome: "repeat" });
});
