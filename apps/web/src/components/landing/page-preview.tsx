import type { ComponentStatus } from "@galena/contracts";
import { Glyph, StatusLabel } from "../status.tsx";

// An example status page for the landing page: three components and their last 90 days, drawn
// like the real strip (a full-height bar per day, worse states as feet at its base). The uptime
// beside each is computed from the sample minutes below, as the page computes it.

type Foot = { day: number; status: Exclude<ComponentStatus, "operational">; minutes: number };
type Row = { name: string; status: ComponentStatus; feet: Foot[] };

const DAYS = 90;
const DAY_MINUTES = 1440;
const ROWS: Row[] = [
  {
    name: "API",
    status: "operational",
    feet: [{ day: 61, status: "partial_outage", minutes: 27 }],
  },
  {
    name: "Dashboard",
    status: "operational",
    feet: [{ day: 30, status: "under_maintenance", minutes: 60 }],
  },
  {
    name: "Webhooks",
    status: "degraded_performance",
    feet: [
      { day: 12, status: "major_outage", minutes: 9 },
      { day: 89, status: "degraded_performance", minutes: 94 },
    ],
  },
];

const FILL: Record<Foot["status"], string> = {
  degraded_performance: "fill-degraded",
  partial_outage: "fill-partial",
  major_outage: "fill-major",
  under_maintenance: "fill-maintenance",
};

/** Percent of minutes outside a partial or major outage, two decimals, as on the page. */
function uptime(feet: Foot[]): string {
  const down = feet
    .filter((f) => f.status === "partial_outage" || f.status === "major_outage")
    .reduce((sum, f) => sum + f.minutes, 0);
  return `${(Math.round(((DAYS * DAY_MINUTES - down) / (DAYS * DAY_MINUTES)) * 10_000) / 100).toFixed(2)}%`;
}

function Strip({ feet }: { feet: Foot[] }) {
  const pitch = 4;
  const height = 28;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${DAYS * pitch - 1} ${height}`}
      className="block h-7 w-full"
      preserveAspectRatio="none"
    >
      {Array.from({ length: DAYS }, (_, day) => {
        const foot = feet.find((f) => f.day === day);
        const outage = foot?.status === "partial_outage" || foot?.status === "major_outage";
        const footHeight = foot
          ? Math.max(outage ? 8 : 3, Math.round((foot.minutes / DAY_MINUTES) * height))
          : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: days are positions and never reorder
          <g key={day}>
            <rect
              x={day * pitch}
              y={0}
              width={3}
              height={height - footHeight - (foot ? 1 : 0)}
              className="fill-operational"
            />
            {foot && (
              <rect
                x={day * pitch}
                y={height - footHeight}
                width={3}
                height={footHeight}
                className={FILL[foot.status]}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function PagePreview() {
  return (
    <figure className="rounded-[10px] border border-mist bg-paper p-5 sm:p-6">
      <figcaption className="font-mono text-[12px] text-slate">An example page</figcaption>
      <p className="mt-3 flex items-center gap-2 text-[22px] font-[650] leading-tight text-degraded">
        <Glyph status="degraded_performance" />
        <span className="text-ink">Some systems degraded</span>
      </p>
      <ul className="mt-5 flex flex-col gap-5">
        {ROWS.map((row) => (
          <li key={row.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[15px] font-semibold">{row.name}</span>
              <StatusLabel status={row.status} />
            </div>
            <div className="mt-2">
              <Strip feet={row.feet} />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[12px] text-slate tabular-nums">
              <span>90 days ago</span>
              <span>{uptime(row.feet)} uptime</span>
            </div>
          </li>
        ))}
      </ul>
    </figure>
  );
}
