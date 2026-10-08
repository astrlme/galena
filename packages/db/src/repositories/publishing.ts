import {
  type MonitorId,
  type MonitorState,
  type PageId,
  pageId,
  type WorkspaceId,
} from "@galena/contracts";
import type { SnapshotInputs, UptimeDay } from "@galena/core";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { monitor, monitorStateChange, page, uptimeDaily, workspace } from "../schema/index.ts";
import { componentGroupRepository, componentRepository } from "./components.ts";
import { incidentRepository } from "./incidents.ts";
import { maintenanceRepository } from "./maintenance.ts";

const DAY = 86_400_000;

export type MonitorTransition = {
  workspaceId: WorkspaceId;
  monitorId: MonitorId;
  from: MonitorState;
  to: MonitorState;
  seq: number;
  at: Date;
};

/**
 * Records a confirmed transition once, keyed by (monitor, seq), and moves the monitor's current
 * state only forward, so a redelivered or late transition never rolls it back. False when the
 * transition was already recorded or the monitor has been deleted.
 */
export async function recordMonitorTransition(db: Db, t: MonitorTransition): Promise<boolean> {
  const scoped = and(eq(monitor.workspaceId, t.workspaceId), eq(monitor.id, t.monitorId));
  return db.transaction(async (tx) => {
    // Locked, so a delete waits for this transaction instead of breaking its foreign key.
    const [exists] = await tx.select({ id: monitor.id }).from(monitor).where(scoped).for("update");
    if (!exists) return false;
    const inserted = await tx
      .insert(monitorStateChange)
      .values({
        id: v7(),
        workspaceId: t.workspaceId,
        monitorId: t.monitorId,
        fromState: t.from,
        toState: t.to,
        seq: t.seq,
        at: t.at,
      })
      .onConflictDoNothing({ target: [monitorStateChange.monitorId, monitorStateChange.seq] })
      .returning({ id: monitorStateChange.id });
    await tx
      .update(monitor)
      .set({ state: t.to, stateSeq: t.seq })
      .where(and(scoped, lt(monitor.stateSeq, t.seq)));
    return inserted.length === 1;
  });
}

/** Every monitor's last recorded state and the transition it came from. */
export function listMonitorStates(db: Db) {
  return db
    .select({
      id: monitor.id,
      workspaceId: monitor.workspaceId,
      state: monitor.state,
      stateSeq: monitor.stateSeq,
    })
    .from(monitor)
    .orderBy(asc(monitor.id));
}

/** The monitor's last confirmed state, or undefined once it has been deleted. */
export async function findMonitorState(db: Db, workspaceId: WorkspaceId, monitorId: MonitorId) {
  const [row] = await db
    .select({ state: monitor.state })
    .from(monitor)
    .where(and(eq(monitor.workspaceId, workspaceId), eq(monitor.id, monitorId)))
    .limit(1);
  return row?.state;
}

/**
 * Each monitor's transitions from `since` on, oldest first, led by the last one before `since`
 * (the state each monitor was in when the period began).
 */
export async function listMonitorTransitions(db: Db, workspaceId: WorkspaceId, since: Date) {
  const columns = {
    monitorId: monitorStateChange.monitorId,
    state: monitorStateChange.toState,
    at: monitorStateChange.at,
  };
  const before = await db
    .selectDistinctOn([monitorStateChange.monitorId], columns)
    .from(monitorStateChange)
    .where(and(eq(monitorStateChange.workspaceId, workspaceId), lt(monitorStateChange.at, since)))
    .orderBy(monitorStateChange.monitorId, desc(monitorStateChange.seq));
  const within = await db
    .select(columns)
    .from(monitorStateChange)
    .where(and(eq(monitorStateChange.workspaceId, workspaceId), gte(monitorStateChange.at, since)))
    .orderBy(asc(monitorStateChange.seq));
  return [...before, ...within];
}

/**
 * The next snapshot version. Take it after the change it covers has committed, never inside
 * that change's transaction: versions are handed out in time order, commits are not.
 */
export async function nextSnapshotVersion(db: Db): Promise<number> {
  const { rows } = (await db.execute(
    sql`select nextval('snapshot_version') as version`,
  )) as unknown as {
    rows: [{ version: string | number }];
  };
  // node-postgres returns a bigint as a string, the Data API as a number.
  return Number(rows[0].version);
}

const layers = { data: "publishedVersion", html: "htmlVersion" } as const;

/**
 * Moves the page's data or HTML version forward to `version`. False when that version or a
 * newer one is already out, which is the caller's cue to stop: the newest publish wins.
 */
export async function advancePageVersion(
  db: Db,
  pageId: PageId,
  layer: keyof typeof layers,
  version: number,
): Promise<boolean> {
  const column = layers[layer];
  const rows = await db
    .update(page)
    .set({ [column]: version })
    .where(and(eq(page.id, pageId), lt(page[column], version)))
    .returning({ id: page.id });
  return rows.length === 1;
}

/** Replaces each (component, day) rollup with the newly computed minutes. */
export async function saveUptimeDays(db: Db, workspaceId: WorkspaceId, days: readonly UptimeDay[]) {
  if (days.length === 0) return;
  await db
    .insert(uptimeDaily)
    .values(
      days.map((d) => ({
        id: v7(),
        workspaceId,
        componentId: d.componentId,
        day: d.date,
        minutes: d.minutes,
      })),
    )
    .onConflictDoUpdate({
      target: [uptimeDaily.componentId, uptimeDaily.day],
      set: { minutes: sql`excluded.minutes`, updatedAt: sql`now()` },
      setWhere: eq(uptimeDaily.workspaceId, workspaceId),
    });
}

/** Every component's rollups from `fromDay` (a UTC date, `YYYY-MM-DD`) on. */
export async function listUptimeDays(
  db: Db,
  workspaceId: WorkspaceId,
  fromDay: string,
): Promise<UptimeDay[]> {
  const rows = await db
    .select({
      componentId: uptimeDaily.componentId,
      date: uptimeDaily.day,
      minutes: uptimeDaily.minutes,
    })
    .from(uptimeDaily)
    .where(and(eq(uptimeDaily.workspaceId, workspaceId), gte(uptimeDaily.day, fromDay)))
    .orderBy(asc(uptimeDaily.day));
  return rows;
}

const pageColumns = {
  id: page.id,
  workspaceId: page.workspaceId,
  slug: page.slug,
  name: page.name,
  publishedVersion: page.publishedVersion,
  htmlVersion: page.htmlVersion,
};
export type PageRow = {
  id: PageId;
  workspaceId: WorkspaceId;
  slug: string;
  name: string;
  publishedVersion: number;
  htmlVersion: number;
};

/**
 * The deployment's status page, created from the workspace's name the first time it publishes;
 * undefined before first-run setup. Known limit: one page per deployment, showing every
 * component; `page_component` chooses them once a deployment has several pages.
 */
export async function ensurePage(db: Db): Promise<PageRow | undefined> {
  const first = () =>
    db.select(pageColumns).from(page).orderBy(asc(page.createdAt), asc(page.id)).limit(1);
  const [existing] = await first();
  if (existing) return existing;
  const [ws] = await db.select({ id: workspace.id, name: workspace.name }).from(workspace).limit(1);
  if (!ws) return undefined;
  await db
    .insert(page)
    .values({ id: pageId.parse(v7()), workspaceId: ws.id, slug: "status", name: ws.name })
    .onConflictDoNothing();
  const [created] = await first();
  return created;
}

/** Everything `buildSnapshot` needs for the page, read at `now`. */
export async function loadSnapshotInputs(
  db: Db,
  target: PageRow,
  options: { snapshotVersion: number; url: string; subscribe: boolean; now: Date },
): Promise<SnapshotInputs> {
  const ws = target.workspaceId;
  const recentFrom = new Date(options.now.getTime() - 14 * DAY);
  const stripFrom = new Date(options.now.getTime() - 89 * DAY).toISOString().slice(0, 10);
  const [groups, components, monitors, incidents, maintenance, uptime] = await Promise.all([
    componentGroupRepository(db).listByWorkspace(ws),
    componentRepository(db).listByWorkspace(ws),
    db
      .select({
        componentId: monitor.componentId,
        state: monitor.state,
        downStatus: monitor.downStatus,
        enabled: monitor.enabled,
        publishPolicy: monitor.publishPolicy,
      })
      .from(monitor)
      .where(eq(monitor.workspaceId, ws)),
    incidentRepository(db).listForPage(ws, recentFrom),
    maintenanceRepository(db).listUnfinished(),
    listUptimeDays(db, ws, stripFrom),
  ]);
  return {
    snapshotVersion: options.snapshotVersion,
    page: { slug: target.slug, name: target.name, url: options.url, subscribe: options.subscribe },
    groups,
    components,
    monitors,
    incidents,
    maintenance,
    uptime,
  };
}
