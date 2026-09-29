import {
  componentId,
  type IncidentStatus,
  incidentId,
  incidentUpdateId,
  workspaceId,
} from "@galena/contracts";
import type { IncidentChange } from "@galena/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, incident, timelineEvent, workspace } from "../schema/index.ts";
import { incidentRepository } from "./incidents.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());
const api = componentId.parse(v7());
const web = componentId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values([
    { id: acme, name: "Acme" },
    { id: other, name: "Other" },
  ]);
  await db.insert(component).values([
    { id: api, workspaceId: acme, name: "API", position: 0 },
    { id: web, workspaceId: acme, name: "Web", position: 1 },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 10, minute));
const change = (
  status: IncidentStatus,
  minute: number,
  extra: Partial<IncidentChange> = {},
): IncidentChange => ({
  update: {
    id: incidentUpdateId.parse(v7()),
    status,
    body: `Update at ${minute}`,
    createdAt: at(minute),
    createdByUserId: null,
  },
  stage: { status, resolvedAt: status === "resolved" ? at(minute) : null },
  ...extra,
});

test("an incident moves from open to resolved with its updates, components and timeline", async () => {
  const repo = incidentRepository(db);
  const id = incidentId.parse(v7());
  await repo.create(
    {
      id,
      workspaceId: acme,
      title: "API errors",
      impact: "major",
      visibility: "published",
      source: "manual",
      startedAt: at(0),
    },
    change("investigating", 0, {
      components: [{ componentId: api, status: "partial_outage" }],
      statusChange: { from: null, to: "investigating" },
    }),
  );
  expect((await repo.list(acme, { open: true })).map((i) => i.id)).toContain(id);

  await repo.append(
    acme,
    id,
    change("identified", 5, {
      impact: "critical",
      components: [
        { componentId: api, status: "major_outage" },
        { componentId: web, status: "degraded_performance" },
      ],
      statusChange: { from: "investigating", to: "identified" },
    }),
  );
  await repo.append(acme, id, change("identified", 7)); // another update, same status
  await repo.append(
    acme,
    id,
    change("resolved", 20, { statusChange: { from: "identified", to: "resolved" } }),
  );

  const found = await repo.findById(acme, id);
  expect(found).toMatchObject({
    title: "API errors",
    status: "resolved",
    impact: "critical",
    resolvedAt: at(20),
    components: [
      { componentId: api, status: "major_outage" },
      { componentId: web, status: "degraded_performance" },
    ],
  });
  expect(found?.updates.map((u) => u.body)).toEqual([
    "Update at 20",
    "Update at 7",
    "Update at 5",
    "Update at 0",
  ]);
  const timeline = await db
    .select({ data: timelineEvent.data })
    .from(timelineEvent)
    .where(eq(timelineEvent.incidentId, id))
    .orderBy(timelineEvent.occurredAt);
  expect(timeline.map((t) => t.data)).toEqual([
    { from: null, to: "investigating" },
    { from: "investigating", to: "identified" },
    { from: "identified", to: "resolved" },
  ]);
  expect((await repo.list(acme, { open: true })).map((i) => i.id)).not.toContain(id);
  expect((await repo.list(acme, { open: false })).map((i) => i.id)).toContain(id);
});

test("another workspace and soft-deleted incidents stay out of sight", async () => {
  const repo = incidentRepository(db);
  const id = incidentId.parse(v7());
  await repo.create(
    {
      id,
      workspaceId: acme,
      title: "Gone",
      impact: "minor",
      visibility: "published",
      source: "manual",
      startedAt: at(30),
    },
    change("investigating", 30),
  );
  expect(await repo.findById(other, id)).toBeUndefined();
  expect(await repo.list(other, { open: true })).toEqual([]);

  await db
    .update(incident)
    .set({ deletedAt: at(31) })
    .where(eq(incident.id, id));
  expect(await repo.findById(acme, id)).toBeUndefined();
  expect((await repo.list(acme, { open: true })).map((i) => i.id)).not.toContain(id);
});
