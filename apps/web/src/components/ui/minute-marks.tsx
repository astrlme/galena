import type { ComponentStatus } from "@galena/contracts";

// One mark per minute in the state vocabulary's heights and inks: the monitor page's last hour,
// the incident page's regions.

export type Mark = ComponentStatus | "none";
const MARKS: Record<
  Exclude<Mark, "none" | "under_maintenance">,
  { height: number; fill: string }
> = {
  operational: { height: 5, fill: "fill-operational" },
  degraded_performance: { height: 12, fill: "fill-degraded" },
  partial_outage: { height: 19, fill: "fill-partial" },
  major_outage: { height: 27, fill: "fill-major" },
};

/**
 * One mark per minute, oldest first, 6 px apart. `fit` lets it shrink to a narrower box instead of
 * keeping its width; without a `label` it is hidden from assistive tech, for rows that say it in
 * words.
 */
export function MinuteMarks({
  marks,
  label,
  fit = false,
}: {
  marks: readonly Mark[];
  label?: string;
  fit?: boolean;
}) {
  const width = Math.max(1, marks.length * 6 - 2);
  const size = {
    ...(fit
      ? { viewBox: `0 0 ${width} 28`, preserveAspectRatio: "none", style: { maxWidth: width } }
      : { width }),
    height: 28,
    className: fit ? "w-full min-w-0" : "shrink-0",
  };
  const content = (
    <>
      <rect x={0} y={27} width={width} height={1} className="fill-mist" />
      {marks.map((mark, i) => {
        const x = i * 6;
        if (mark === "none" || mark === "under_maintenance") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
            <rect key={i} x={x + 1.5} y={26} width={1} height={1} className="fill-ash" />
          );
        }
        const { height, fill } = MARKS[mark];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
          <rect key={i} x={x} y={27 - height} width={4} height={height} className={fill} />
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
