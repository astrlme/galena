import { componentId, monitorId, pageId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, monitor, page, workspace } from "../schema/index.ts";
import {
  advancePageVersion,
  listMonitorTransitions,
  listUptimeDays,
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
const acmePage = pageId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values({ id: acme, name: "Acme" });
  await db.insert(page).values({ id: acmePage, workspaceId: acme, slug: "acme", name: "Acme" });
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
