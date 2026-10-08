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
    "investigating",
    change("identified", 5, {
      impact: "critical",
      components: [
        { componentId: api, status: "major_outage" },
        { componentId: web, status: "degraded_performance" },
      ],
      statusChange: { from: "investigating", to: "identified" },
    }),
  );
  await repo.append(acme, id, "identified", change("identified", 7)); // same status again
  await repo.append(
    acme,
    id,
    "identified",
    change("resolved", 20, { statusChange: { from: "identified", to: "resolved" } }),
  );
  // Someone else's screen still showed "identified": their update must not land.
  expect(await repo.append(acme, id, "identified", change("monitoring", 21))).toBe(false);

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

test("one open incident per dedup key; a dismissed draft frees it, and only drafts are decided", async () => {
  const repo = incidentRepository(db);
  const checkout = componentId.parse(v7());
  await db
    .insert(component)
    .values({ id: checkout, workspaceId: acme, name: "Checkout", position: 2 });
  const draft = (minute: number) => ({
    id: incidentId.parse(v7()),
    workspaceId: acme,
    title: "Checkout is down",
    impact: "major" as const,
    visibility: "draft" as const,
    source: "monitor" as const,
    startedAt: at(minute),
    dedupKey: "mon:checkout",
    approvalDeadline: at(minute + 10),
  });
  const first = (minute: number) =>
    change("investigating", minute, {
      components: [{ componentId: checkout, status: "major_outage" }],
    });

  const one = draft(40);
  expect(await repo.createOnce(one, first(40))).toEqual({ id: one.id, created: true });
  // A retried transition finds the draft it already opened, and writes nothing more.
  expect(await repo.createOnce(draft(41), first(41))).toEqual({ id: one.id, created: false });
  expect((await repo.openAffecting(acme, checkout)).map((i) => [i.id, i.approvalDeadline])).toEqual(
    [[one.id, at(50)]],
  );

  expect(await repo.decide(acme, one.id, "dismissed")).toBe(true);
  expect(await repo.decide(acme, one.id, "published")).toBe(false);
  expect(await repo.openAffecting(acme, checkout)).toEqual([]);
  // A dismissed draft is past, never open, though it never resolves.
  expect((await repo.list(acme, { open: true })).map((i) => i.id)).not.toContain(one.id);
  expect((await repo.list(acme, { open: false })).map((i) => i.id)).toContain(one.id);

  const two = draft(60);
  expect(await repo.createOnce(two, first(60))).toEqual({ id: two.id, created: true });
  // The approval run stores its token, so an answer from Slack can wake it.
  expect(await repo.findApprovalToken(acme, two.id)).toBeNull();
  await repo.setApprovalToken(acme, two.id, "waitpoint_123");
  expect(await repo.findApprovalToken(acme, two.id)).toBe("waitpoint_123");
  expect(await repo.decide(acme, two.id, "published")).toBe(true);
  const published = await repo.findById(acme, two.id);
  expect(published).toMatchObject({ visibility: "published", approvalDeadline: null });
});
