import type { CheckStatus, ComponentStatus } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts/copy";

// One mark per minute in the state vocabulary's heights and inks: the monitor page's last hour,
// Home's rail of monitors, the incident page's regions.

export type Mark = ComponentStatus | "none";
const FILLS: Record<Exclude<Mark, "none" | "under_maintenance">, string> = {
  operational: "fill-operational",
  degraded_performance: "fill-degraded",
  partial_outage: "fill-partial",
  major_outage: "fill-major",
};

/** Each size's pitch, bar width and baseline, and its heights by severity, in whole pixels. */
const SIZES = {
  normal: {
    pitch: 6,
    bar: 4,
    base: 27,
    heights: { operational: 5, degraded_performance: 12, partial_outage: 19, major_outage: 27 },
  },
  small: {
    pitch: 3,
    bar: 2,
    base: 15,
    heights: { operational: 3, degraded_performance: 7, partial_outage: 11, major_outage: 15 },
  },
} as const;

const MINUTE = 60_000;
type Check = { scheduledAt: string; status: CheckStatus };

/**
 * A monitor's minute: down only when its quorum of regions failed it, as the uptime bar counts it.
 * A failure in fewer regions isn't an outage; a probe error says nothing.
 */
function quorumMark(results: readonly Check[], quorum: number, downStatus: ComponentStatus): Mark {
  const reported = results.filter((r) => r.status !== "error");
  if (reported.length === 0) return "none";
  if (reported.filter((r) => r.status === "down").length >= quorum) return downStatus;
  return reported.some((r) => r.status === "degraded") ? "degraded_performance" : "operational";
}

/** The newest minute with results and the `minutes - 1` before it, oldest first. */
export function quorumMarks(
  results: readonly Check[],
  quorum: number,
  downStatus: ComponentStatus,
  minutes: number,
): Mark[] {
  const newest = Math.max(0, ...results.map((r) => Date.parse(r.scheduledAt)));
  const byMinute = Map.groupBy(results, (r) => Date.parse(r.scheduledAt));
  return Array.from({ length: minutes }, (_, i) =>
    quorumMark(byMinute.get(newest - (minutes - 1 - i) * MINUTE) ?? [], quorum, downStatus),
  );
}

/** "Last 60 minutes: 56 operational, 3 degraded performance, 1 major outage." */
export function describeMarks(marks: readonly Mark[]) {
  const counts = new Map<Mark, number>();
  for (const mark of marks) counts.set(mark, (counts.get(mark) ?? 0) + 1);
  const said = [...counts].map(
    ([mark, n]) =>
      `${n} ${mark === "none" ? "without results" : componentStatusLabels[mark].toLowerCase()}`,
  );
  return `Last ${marks.length} minutes: ${said.join(", ")}.`;
}

/**
 * One mark per minute, oldest first, 6 px apart. `fit` lets it shrink to a narrower box instead of
 * keeping its width, `small` draws it 3 px apart and 16 px high for a list row; without a `label`
 * it is hidden from assistive tech, for rows that say it in words.
 */
export function MinuteMarks({
  marks,
  label,
  fit = false,
  small = false,
}: {
  marks: readonly Mark[];
  label?: string;
  fit?: boolean;
  small?: boolean;
}) {
  const g = SIZES[small ? "small" : "normal"];
  const width = Math.max(1, marks.length * g.pitch - (g.pitch - g.bar));
  const height = g.base + 1;
  const size = fit
    ? {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "none",
        style: { maxWidth: width },
        height,
        className: "w-full min-w-0",
      }
    : { width, height, className: "shrink-0" };
  const content = (
    <>
      <rect x={0} y={g.base} width={width} height={1} className="fill-mist" />
      {marks.map((mark, i) => {
        const x = i * g.pitch;
        if (mark === "none" || mark === "under_maintenance") {
          // A dot in the bar's middle: a minute without results.
          const dot = x + (g.bar - 1) / 2;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
            <rect key={i} x={dot} y={g.base - 1} width={1} height={1} className="fill-ash" />
          );
        }
        const h = g.heights[mark];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
          <rect key={i} x={x} y={g.base - h} width={g.bar} height={h} className={FILLS[mark]} />
        );
      })}
    </>
  );
  return label ? (
    <svg role="img" aria-label={label} {...size}>
      {content}
    </svg>
  ) : (
    <svg aria-hidden="true" {...size}>
      {content}
    </svg>
  );
}
