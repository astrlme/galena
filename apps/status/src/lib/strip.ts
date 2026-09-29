import { type ComponentStatus, componentStatusLabels, type SnapshotDay } from "@galena/contracts";

// The signal strip: one mark per day, 4 px wide with 2 px gaps, bottom-aligned in a 28 px row on
// a 1 px baseline. More ink, and a taller mark, for a worse day. One path per kind of mark keeps
// 90 days to a few hundred bytes.

export const MARK = 4;
export const GAP = 2;
export const ROW = 28;
const BASELINE = ROW - 1;

type Mark = ComponentStatus | "none";
/** Height (share of the row) and the class that inks it. */
const MARKS: Record<Mark, { height: number; className: string }> = {
  operational: { height: 0.2, className: "m-ok" },
  degraded_performance: { height: 0.45, className: "m-degraded" },
  partial_outage: { height: 0.7, className: "m-partial" },
  major_outage: { height: 1, className: "m-major" },
  under_maintenance: { height: 1, className: "m-maintenance" },
  none: { height: 0, className: "m-none" },
};

export const stripWidth = (days: number) => days * (MARK + GAP) - GAP;

/** One `<path>` per kind of mark, oldest day at the left. */
export function stripPaths(days: readonly SnapshotDay[]): { className: string; d: string }[] {
  const byMark = new Map<Mark, string[]>();
  days.forEach((day, i) => {
    const mark: Mark = day.worst ?? "none";
    const x = i * (MARK + GAP);
    const segment =
      mark === "none"
        ? `M${x + 1.5} ${BASELINE - 1}h1v1h-1z` // a 1 px dot on the baseline
        : (() => {
            const h = Math.round((BASELINE - 1) * MARKS[mark].height);
            return `M${x} ${BASELINE - h}h${MARK}v${h}h-${MARK}z`;
          })();
    byMark.set(mark, [...(byMark.get(mark) ?? []), segment]);
  });
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
