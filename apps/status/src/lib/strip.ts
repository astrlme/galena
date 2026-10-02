import {
  type ComponentStatus,
  componentStatuses,
  componentStatusLabels,
  type SnapshotDay,
  type SnapshotIncident,
} from "@galena/contracts";

// The signal strip: one column per day, 4 px wide with 2 px gaps, in a 28 px row on a 1 px
// baseline. A day with data is a green column; a worse day fills its foot with its state's
// colour, taller for worse, and the green resumes 1 px above it, so the height reads without
// colour too. One path per kind of mark keeps 90 days to a few hundred bytes.

export const MARK = 4;
export const GAP = 2;
export const ROW = 28;
const BASELINE = ROW - 1;

type Mark = ComponentStatus | "none";
/** Height of the foot (share of the row) and the class that colours it. */
const MARKS: Record<Mark, { height: number; className: string }> = {
  operational: { height: 0, className: "m-ok" },
  degraded_performance: { height: 0.45, className: "m-degraded" },
  partial_outage: { height: 0.7, className: "m-partial" },
  major_outage: { height: 1, className: "m-major" },
  under_maintenance: { height: 1, className: "m-maintenance" },
  none: { height: 0, className: "m-none" },
};

export const stripWidth = (days: number) => days * (MARK + GAP) - GAP;

const rect = (x: number, y: number, h: number) => `M${x} ${y}h${MARK}v${h}h-${MARK}z`;

/** One `<path>` per kind of mark, oldest day at the left. */
export function stripPaths(days: readonly SnapshotDay[]): { className: string; d: string }[] {
  const byMark = new Map<Mark, string[]>();
  const add = (mark: Mark, segment: string) =>
    byMark.set(mark, [...(byMark.get(mark) ?? []), segment]);
  for (const [i, day] of days.entries()) {
    const mark: Mark = day.worst ?? "none";
    const x = i * (MARK + GAP);
    if (mark === "none") {
      add(mark, `M${x + 1.5} ${BASELINE - 1}h1v1h-1z`); // a 1 px dot on the baseline
      continue;
    }
    if (mark === "operational") {
      add(mark, rect(x, 0, BASELINE));
      continue;
    }
    const h = Math.round((BASELINE - 1) * MARKS[mark].height);
    add(mark, rect(x, BASELINE - h, h));
    // Maintenance is an outline of its own; other days are green above their foot.
    const green = BASELINE - h - 1;
    if (mark !== "under_maintenance" && green > 0) add("operational", rect(x, 0, green));
  }
  return [...byMark].map(([mark, segments]) => ({
    className: MARKS[mark].className,
    d: segments.join(""),
  }));
}

/** What a day says in words, for the hidden table and the keyboard label. */
export function describeDay(day: SnapshotDay): string {
  if (day.worst === null) return "No data";
  const label = componentStatusLabels[day.worst];
  return day.downMinutes > 0 ? `${label}, ${day.downMinutes} minutes down` : label;
}

/** What a day's popover shows, compact enough to travel in the page's HTML. */
export type DayDetail = {
  /** The day in words, for the live region. */
  t: string;
  /** Minutes in each state it reached, in the state vocabulary's order. */
  m: Array<[ComponentStatus, number]>;
  /** Incidents that touched the component that day: title, start, end (null while open), state. */
  n: Array<[string, string, string | null, ComponentStatus]>;
};

const DAY_MS = 86_400_000;

/**
 * The popover's detail for one day of one component, or undefined when there is nothing to add:
 * no data, or a whole operational day with no incident (the page says "Operational, 24h").
 */
export function dayDetail(
  day: SnapshotDay,
  incidents: readonly SnapshotIncident[],
  componentId: string,
  now: string,
): DayDetail | undefined {
  const from = Date.parse(`${day.date}T00:00:00.000Z`);
  const n = incidents.flatMap((i): DayDetail["n"] => {
    const affected = i.components.find((c) => c.componentId === componentId);
    const end = i.resolvedAt ? Date.parse(i.resolvedAt) : Date.parse(now);
    if (!affected || Date.parse(i.startedAt) >= from + DAY_MS || end <= from) return [];
    return [[i.title, i.startedAt, i.resolvedAt, affected.status]];
  });
  const minutes = day.minutes ?? {};
  const m = componentStatuses.flatMap((s): DayDetail["m"] => (minutes[s] ? [[s, minutes[s]]] : []));
  const whole = m.length === 1 && m[0]?.[0] === "operational" && m[0][1] >= 1440;
  if (day.worst === null && n.length === 0) return undefined;
  if (whole && n.length === 0) return undefined;
  return { t: describeDay(day), m, n };
}
