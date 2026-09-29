import { type Clock, rollupUptime } from "@galena/core";
import {
  componentRepository,
  type Db,
  ensurePage,
  incidentRepository,
  listMonitorTransitions,
  maintenanceRepository,
  monitorRepository,
  nextSnapshotVersion,
  saveUptimeDays,
} from "@galena/db";

const DAY = 86_400_000;

export type RollupDeps = {
  db: Db;
  clock: Clock;
  /** Starts `page.publish` for a version taken after the rollup was saved. */
  publish: (version: number) => Promise<void>;
};

/**
 * Recomputes yesterday's and today's minutes per status for every component from the recorded
 * monitor transitions, incidents and maintenance windows, then republishes the page, so the
 * strip and "Updated" stay current even when nothing else changes.
 */
export async function rollUpUptime(deps: RollupDeps): Promise<{ days: number } | undefined> {
  const target = await ensurePage(deps.db);
  if (!target) return undefined;
  const ws = target.workspaceId;
  const now = deps.clock.now();
  const since = new Date(Math.floor(now.getTime() / DAY) * DAY - DAY);
  const [components, monitors, transitions, incidents, maintenance] = await Promise.all([
    componentRepository(deps.db).listByWorkspace(ws),
    monitorRepository(deps.db).listByWorkspace(ws),
    listMonitorTransitions(deps.db, ws, since),
    incidentRepository(deps.db).listForPage(ws, since),
    maintenanceRepository(deps.db).list(ws),
  ]);
  const days = rollupUptime({ components, monitors, transitions, incidents, maintenance }, now);
  await saveUptimeDays(deps.db, ws, days);
  await deps.publish(await nextSnapshotVersion(deps.db));
  return { days: days.length };
}
