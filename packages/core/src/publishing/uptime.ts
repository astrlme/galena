import type {
  ComponentId,
  ComponentStatus,
  DownStatus,
  IncidentComponentStatus,
  MonitorId,
  MonitorState,
  PublishPolicy,
} from "@galena/contracts";
import type { Incident, Maintenance } from "../ports.ts";
import { componentStatus } from "../status/aggregate.ts";

/** An `internal_only` monitor never reaches the page: no status, history or uptime of its own. */
export const onPage = (monitor: { publishPolicy: PublishPolicy }) =>
  monitor.publishPolicy !== "internal_only";

const MINUTE = 60_000;
const DAY = 86_400_000;

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
 * applying the same rule as the live status at every moment something changed. Only minutes in
 * which some monitor had a verdict count: without one there is nothing measured to report, so
 * incidents and windows alone add no history.
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
    const monitors = history.monitors.map(({ downStatus, changes }) => ({
      downStatus,
      state: changes.findLast((c) => c.at <= start)?.state ?? ("unknown" as const),
    }));
    if (monitors.every((m) => m.state === "unknown")) continue;
    const status = componentStatus({
      current: "operational",
      monitors,
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

/** Whole minutes per state, leaving out states held for less than a minute. */
export function wholeMinutes(
  minutes: Partial<Record<ComponentStatus, number>>,
): Partial<Record<ComponentStatus, number>> {
  return Object.fromEntries(
    Object.entries(minutes).flatMap(([status, spent]) =>
      spent >= 1 ? [[status, Math.floor(spent)]] : [],
    ),
  );
}

/** What the hourly rollup reads: enough to replay yesterday and today for every component. */
export type RollupInputs = {
  components: ReadonlyArray<{ id: ComponentId }>;
  monitors: ReadonlyArray<{
    id: MonitorId;
    componentId: ComponentId | null;
    downStatus: DownStatus;
    publishPolicy: PublishPolicy;
  }>;
  /** Each monitor's confirmed transitions since yesterday began, led by the one before that. */
  transitions: ReadonlyArray<{ monitorId: MonitorId; state: MonitorState; at: Date }>;
  incidents: ReadonlyArray<
    Pick<Incident, "visibility" | "startedAt" | "resolvedAt" | "components">
  >;
  maintenance: ReadonlyArray<
    Pick<Maintenance, "startsAt" | "endsAt" | "cancelledAt" | "componentIds">
  >;
};

/** Minutes per status for every component, yesterday whole and today up to `now` (UTC days). */
export function rollupUptime(
  inputs: RollupInputs,
  now: Date,
): Array<{
  componentId: ComponentId;
  date: string;
  minutes: Partial<Record<ComponentStatus, number>>;
}> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return inputs.components.flatMap(({ id }) => {
    const history: ComponentHistory = {
      monitors: inputs.monitors
        .filter((m) => m.componentId === id && onPage(m))
        .map((m) => ({
          downStatus: m.downStatus,
          changes: inputs.transitions
            .filter((t) => t.monitorId === m.id)
            .map((t) => ({ at: t.at.getTime(), state: t.state })),
        })),
      incidents: inputs.incidents
        .filter((i) => i.visibility === "published")
        .flatMap((i) =>
          i.components
            .filter((c) => c.componentId === id)
            .map((c) => ({
              from: i.startedAt.getTime(),
              to: i.resolvedAt?.getTime() ?? now.getTime(),
              status: c.status,
            })),
        ),
      maintenance: inputs.maintenance
        .filter((w) => w.cancelledAt === null && w.componentIds.includes(id))
        .map((w) => ({ from: w.startsAt.getTime(), to: w.endsAt.getTime() })),
    };
    // A day nothing was measured has no row, so the strip shows no data for it.
    return [today - DAY, today].flatMap((start) => {
      const minutes = statusMinutes(history, start, Math.min(start + DAY, now.getTime()));
      if (Object.keys(minutes).length === 0) return [];
      return [{ componentId: id, date: new Date(start).toISOString().slice(0, 10), minutes }];
    });
  });
}
