import {
  componentId,
  type IncidentStatus,
  incidentId,
  incidentUpdateId,
  monitorId,
  type PageId,
  workspaceId,
} from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, monitor, page, workspace } from "../schema/index.ts";
import { incidentRepository } from "./incidents.ts";
import {
  advancePageVersion,
  ensurePage,
  listMonitorTransitions,
  listUptimeDays,
  loadSnapshotInputs,
  nextSnapshotVersion,
  recordMonitorTransition,
  saveUptimeDays,
} from "./publishing.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const web = componentId.parse(v7());
const api = monitorId.parse(v7());
let acmePage: PageId;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values({ id: acme, name: "Acme" });
  await db.insert(component).values({ id: web, workspaceId: acme, name: "Web", position: 0 });
  await db.insert(monitor).values({
    id: api,
    workspaceId: acme,
    componentId: web,
    name: "API health",
    type: "http",
    http: { url: "https://api.example.com/health" },
    detection: {},
  } as typeof monitor.$inferInsert);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const at = (iso: string) => new Date(iso);

test("the first publish creates the page from the workspace's name, then finds it", async () => {
  const created = await ensurePage(db);
  expect(created).toMatchObject({ workspaceId: acme, slug: "status", name: "Acme" });
  acmePage = created?.id as PageId;
  expect((await ensurePage(db))?.id).toBe(acmePage);
});
const stateOf = async () => {
  const [row] = await db
    .select({ state: monitor.state, seq: monitor.stateSeq })
    .from(monitor)
    .where(eq(monitor.id, api));
  return row;
};

test("records each transition once and never moves a monitor's state backwards", async () => {
  const t = { workspaceId: acme, monitorId: api };
  expect(await stateOf()).toEqual({ state: "unknown", seq: 0 });
  const up = { ...t, from: "unknown", to: "up", seq: 1, at: at("2026-09-28T23:00:00Z") } as const;
  const down = { ...t, from: "up", to: "down", seq: 2, at: at("2026-09-29T10:00:00Z") } as const;
  expect(await recordMonitorTransition(db, up)).toBe(true);
  expect(await recordMonitorTransition(db, down)).toBe(true);
  // A redelivery of the first transition, arriving late.
  expect(await recordMonitorTransition(db, up)).toBe(false);
  expect(await stateOf()).toEqual({ state: "down", seq: 2 });

  const recovered = {
    ...t,
    from: "down",
    to: "up",
    seq: 3,
    at: at("2026-09-29T10:30:00Z"),
  } as const;
  await recordMonitorTransition(db, recovered);
  expect(await listMonitorTransitions(db, acme, at("2026-09-29T00:00:00Z"))).toEqual([
    { monitorId: api, state: "up", at: up.at },
    { monitorId: api, state: "down", at: down.at },
    { monitorId: api, state: "up", at: recovered.at },
  ]);
});

test("a transition for a deleted monitor is skipped", async () => {
  const gone = monitorId.parse(v7());
  const transition = {
    workspaceId: acme,
    monitorId: gone,
    from: "up",
    to: "down",
    seq: 1,
  } as const;
  expect(await recordMonitorTransition(db, { ...transition, at: at("2026-09-29T11:00:00Z") })).toBe(
    false,
  );
});

test("snapshot versions count up from 1", async () => {
  const first = await nextSnapshotVersion(db);
  expect(first).toBeGreaterThanOrEqual(1);
  expect(await nextSnapshotVersion(db)).toBe(first + 1);
});

test("a page version only moves forward, separately for data and HTML", async () => {
  expect(await advancePageVersion(db, acmePage, "data", 5)).toBe(true);
  expect(await advancePageVersion(db, acmePage, "data", 3)).toBe(false);
  expect(await advancePageVersion(db, acmePage, "data", 5)).toBe(false);
  expect(await advancePageVersion(db, acmePage, "html", 3)).toBe(true);
  const [row] = await db
    .select({ data: page.publishedVersion, html: page.htmlVersion })
    .from(page)
    .where(eq(page.id, acmePage));
  expect(row).toEqual({ data: 5, html: 3 });
});

test("saving a day's rollup again replaces its minutes", async () => {
  await saveUptimeDays(db, acme, [
    { componentId: web, date: "2026-09-28", minutes: { operational: 1440 } },
    { componentId: web, date: "2026-09-29", minutes: { operational: 600 } },
  ]);
  await saveUptimeDays(db, acme, [
    { componentId: web, date: "2026-09-29", minutes: { operational: 690, major_outage: 30 } },
  ]);
  expect(await listUptimeDays(db, acme, "2026-09-29")).toEqual([
    { componentId: web, date: "2026-09-29", minutes: { operational: 690, major_outage: 30 } },
  ]);
});

test("loads open incidents with their updates and those resolved in the last 14 days", async () => {
  const repo = incidentRepository(db);
  const open = async (title: string, status: IncidentStatus, startedAt: Date) => {
    const id = incidentId.parse(v7());
    await repo.create(
      {
        id,
        workspaceId: acme,
        title,
        impact: "minor",
        visibility: "published",
        source: "manual",
        startedAt,
      },
      {
        update: {
          id: incidentUpdateId.parse(v7()),
          status,
          body: title,
          createdAt: startedAt,
          createdByUserId: null,
        },
        stage: { status, resolvedAt: status === "resolved" ? startedAt : null },
        components: [{ componentId: web, status: "degraded_performance" }],
      },
    );
    return id;
  };
  const now = at("2026-09-29T12:00:00Z");
  const current = await open("Slow pages", "investigating", at("2026-09-29T11:00:00Z"));
  const recent = await open("Errors last week", "resolved", at("2026-09-22T11:00:00Z"));
  await open("Errors last month", "resolved", at("2026-09-01T11:00:00Z"));

  const target = await ensurePage(db);
  if (!target) throw new Error("no page");
  const inputs = await loadSnapshotInputs(db, target, {
    snapshotVersion: 9,
    url: "https://status.example.com",
    subscribe: true,
    now,
  });
  expect(inputs.page).toEqual({
    slug: "status",
    name: "Acme",
    url: "https://status.example.com",
    subscribe: true,
  });
  expect(inputs.components.map((c) => c.id)).toEqual([web]);
  expect(inputs.monitors).toEqual([
    {
      componentId: web,
      state: "up",
      downStatus: "major_outage",
      enabled: true,
      publishPolicy: "approve",
    },
  ]);
  expect(inputs.incidents.map((i) => i.id)).toEqual([current, recent]);
  expect(inputs.incidents[0]).toMatchObject({
    components: [{ componentId: web, status: "degraded_performance" }],
    updates: [{ status: "investigating", body: "Slow pages" }],
  });
  expect(inputs.uptime.map((d) => d.date)).toEqual(["2026-09-28", "2026-09-29"]);
});
