import type {
  ComponentStatus,
  DownStatus,
  IncidentComponentStatus,
  MonitorState,
} from "@galena/contracts";
import { componentStatus } from "../status/aggregate.ts";

const MINUTE = 60_000;

/** For a day's mark: more ink means worse. Maintenance shows only when nothing worse happened. */
export const SEVERITY_RANK: Record<ComponentStatus, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

type Interval = { from: number; to: number };

/** Everything that said something about one component over time (epoch ms, `[from, to)`). */
export type ComponentHistory = {
  /** Each monitor's confirmed states: a state holds from `at` until the next change. */
  monitors: ReadonlyArray<{
    downStatus: DownStatus;
    changes: ReadonlyArray<{ at: number; state: MonitorState }>;
  }>;
  /** While each published incident was open, the status it gave the component. */
  incidents: ReadonlyArray<Interval & { status: IncidentComponentStatus }>;
  maintenance: readonly Interval[];
};

const covers = (i: Interval, t: number) => i.from <= t && t < i.to;

/**
 * Minutes spent in each status from `from` to `until` (the end of a day, or now for today),
 * applying the same rule as the live status at every moment something changed.
 */
export function statusMinutes(
  history: ComponentHistory,
  from: number,
  until: number,
): Partial<Record<ComponentStatus, number>> {
  const edges = new Set([from, until]);
  const within = (t: number) => t > from && t < until && edges.add(t);
  for (const monitor of history.monitors) for (const c of monitor.changes) within(c.at);
  for (const i of [...history.incidents, ...history.maintenance]) {
    within(i.from);
    within(i.to);
  }
  const points = [...edges].sort((a, b) => a - b);

  const minutes: Partial<Record<ComponentStatus, number>> = {};
  for (const [k, start] of points.slice(0, -1).entries()) {
    const end = points[k + 1] ?? until;
    const status = componentStatus({
      current: "operational",
      monitors: history.monitors.map(({ downStatus, changes }) => ({
        downStatus,
        state: changes.findLast((c) => c.at <= start)?.state ?? "unknown",
      })),
      incidents: history.incidents
        .filter((i) => covers(i, start))
        .map((i) => ({
          status: "investigating",
          visibility: "published",
          componentStatus: i.status,
        })),
      inMaintenance: history.maintenance.some((w) => covers(w, start)),
      manualStatus: null,
    });
    minutes[status] = (minutes[status] ?? 0) + (end - start) / MINUTE;
  }
  return minutes;
}

/** The strip's mark for a day: its worst state that lasted a minute, and its outage minutes. */
export function dayMark(minutes: Partial<Record<ComponentStatus, number>>): {
  worst: ComponentStatus | null;
  downMinutes: number;
} {
  let worst: ComponentStatus | null = null;
  for (const [status, spent] of Object.entries(minutes) as [ComponentStatus, number][]) {
    if (spent < 1) continue;
    if (worst === null || SEVERITY_RANK[status] > SEVERITY_RANK[worst]) worst = status;
  }
  if (worst === null && Object.keys(minutes).length > 0) worst = "operational";
  const down = (minutes.partial_outage ?? 0) + (minutes.major_outage ?? 0);
  // Whole minutes only, like the mark: a blip under a minute is noise.
  return { worst, downMinutes: Math.floor(down) };
}
