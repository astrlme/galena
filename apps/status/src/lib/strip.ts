import {
  type ComponentStatus,
  componentStatuses,
  componentStatusLabels,
  type SnapshotDay,
  type SnapshotIncident,
} from "@galena/contracts";

// The signal strip: one column per day, 4 px wide with 2 px gaps, in a 28 px row on a 1 px
// baseline. A day with data is a green column. Each worse state it reached takes a foot in its
// own colour, as tall as its share of the day (at least 8 px for an outage, 3 px otherwise; worst
// at the bottom), and the green resumes 1 px above, so a foot's outline reads without colour
// too. One path per kind of mark keeps 90 days to a few hundred bytes.

export const MARK = 4;
export const GAP = 2;
export const ROW = 28;
const BASELINE = ROW - 1;
/** A full column, the whole row above the baseline. */
const FULL = BASELINE;
/** The shortest foot, so a few minutes still show; an outage is never easy to miss. */
const MIN_FOOT: Record<ComponentStatus, number> = {
  operational: 0,
  degraded_performance: 3,
  under_maintenance: 3,
  partial_outage: 8,
  major_outage: 8,
};

type Mark = ComponentStatus | "none";
/** The class that colours each kind of mark. */
const CLASSES: Record<Mark, string> = {
  operational: "m-ok",
  degraded_performance: "m-degraded",
  partial_outage: "m-partial",
  major_outage: "m-major",
  under_maintenance: "m-maintenance",
  none: "m-none",
};
/** Feet from the bottom up: the worst state lowest. */
const FEET = [
  "major_outage",
  "partial_outage",
  "degraded_performance",
  "under_maintenance",
] as const;
/** Snapshots from before minutes were kept: the foot's height is the worst state's severity. */
const SEVERITY_HEIGHT: Record<(typeof FEET)[number], number> = {
  major_outage: 1,
  partial_outage: 0.7,
  degraded_performance: 0.45,
  under_maintenance: 1,
};

export const stripWidth = (days: number) => days * (MARK + GAP) - GAP;

const rect = (x: number, y: number, h: number) => `M${x} ${y}h${MARK}v${h}h-${MARK}z`;

/** The feet of one day, bottom up: each state and its height in px. */
function feet(day: SnapshotDay): Array<[ComponentStatus, number]> {
  const worst = day.worst;
  if (worst === null || worst === "operational") return [];
  if (!day.minutes) return [[worst, Math.round(FULL * SEVERITY_HEIGHT[worst])]];
  const minutes = day.minutes;
  const observed = Object.values(minutes).reduce((sum, m) => sum + m, 0);
  return FEET.flatMap((state): Array<[ComponentStatus, number]> => {
    const spent = minutes[state] ?? 0;
    const share = Math.round((FULL * spent) / observed);
    return spent > 0 ? [[state, Math.max(MIN_FOOT[state], share)]] : [];
  });
}

/** One `<path>` per kind of mark, oldest day at the left. */
export function stripPaths(days: readonly SnapshotDay[]): { className: string; d: string }[] {
  const byMark = new Map<Mark, string[]>();
  const add = (mark: Mark, segment: string) =>
    byMark.set(mark, [...(byMark.get(mark) ?? []), segment]);
  for (const [i, day] of days.entries()) {
    const x = i * (MARK + GAP);
    if (day.worst === null) {
      add("none", `M${x + 1.5} ${BASELINE - 1}h1v1h-1z`); // a 1 px dot on the baseline
      continue;
    }
    let top = FULL;
    for (const [state, height] of feet(day)) {
      const h = Math.min(height, top);
      if (h <= 0) break;
      add(state, rect(x, top - h, h));
      top -= h + 1; // the 1 px gap above each foot
    }
    if (top > 0) add("operational", rect(x, 0, top));
  }
  return [...byMark].map(([mark, segments]) => ({
    className: CLASSES[mark],
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
