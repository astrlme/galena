"use client";

import { useState } from "react";
import { Button } from "../../../../components/button.tsx";
import { columnsFor, DataTable } from "../../../../components/ui/data-table.tsx";
import { spanLabel } from "../../../../lib/time.ts";
import { latency } from "../monitor-row.ts";
import { AXIS, type Hover, type Point, READOUT, type Total } from "./chart-data.ts";
import { RegionChart } from "./region-chart.tsx";

const ms = (value: number | null) => (value === null ? "No response" : latency(value));

// Time, p95 and down always; the rest as the table has room, so it never scrolls sideways.
const right = (show = "") =>
  ({ meta: { className: `text-right tabular-nums ${show ? `hidden ${show}` : ""}` } }) as const;
const col = columnsFor<Point & { id: string }>();
const columns = col.columns([
  col.accessor("at", {
    header: "Time",
    sortFn: "text",
    cell: ({ getValue }) => spanLabel(getValue()),
    meta: { className: "tabular-nums whitespace-nowrap" },
  }),
  col.accessor((p) => p.medianMs ?? -1, {
    id: "median",
    header: "Median",
    sortFn: "basic",
    cell: ({ row }) => ms(row.original.medianMs),
    ...right("@md:table-cell"),
  }),
  col.accessor((p) => p.p95Ms ?? -1, {
    id: "p95",
    header: "p95",
    sortFn: "basic",
    cell: ({ row }) => ms(row.original.p95Ms),
    ...right(),
  }),
  col.accessor((p) => p.maxMs ?? -1, {
    id: "max",
    header: "Slowest",
    sortFn: "basic",
    cell: ({ row }) => ms(row.original.maxMs),
    ...right("@xl:table-cell"),
  }),
  col.accessor("checks", { header: "Checks", sortFn: "basic", ...right("@lg:table-cell") }),
  col.accessor("down", { header: "Down", sortFn: "basic", ...right() }),
]);

/**
 * What a hovered span says, beside the cursor (on its left near the plot's right edge, and
 * never past the chart's sides); the table carries the same numbers.
 */
function Readout({ point, hover }: { point: Point; hover: Hover }) {
  const beside =
    hover.left + 16 + READOUT > hover.width ? hover.left - 16 - READOUT : hover.left + 16;
  const left = Math.max(0, Math.min(AXIS + beside, AXIS + hover.width + 56 - READOUT));
  const row = (name: string, value: string) => (
    <li className="flex gap-3">
      <span className="text-slate">{name}</span>
      <span className="ml-auto tabular-nums">{value}</span>
    </li>
  );
  const { dns, connect, tls, ttfb } = point.phases;
  return (
    <div
      aria-hidden="true"
      data-readout=""
      style={{ left, width: READOUT }}
      className="pointer-events-none absolute top-0 z-10 rounded-xl border border-mist bg-surface p-3 text-[14px]"
    >
      <p className="font-semibold tabular-nums">{spanLabel(point.at)}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {row("Median", ms(point.medianMs))}
        {row("p95", ms(point.p95Ms))}
        {row("Slowest", ms(point.maxMs))}
        {row("Down", `${point.down} of ${point.checks}`)}
        {dns !== null && row("DNS", latency(dns))}
        {connect !== null && row("Connect", latency(connect))}
        {tls !== null && row("TLS", latency(tls))}
        {ttfb !== null && row("First byte", latency(ttfb))}
      </ul>
    </div>
  );
}

/** A region's whole range in words, and its slowest span. */
function sentence(
  region: string,
  spoken: string,
  per: string,
  total: Total | undefined,
  rows: Point[],
) {
  if (!total || total.checks === 0) return `${region}, ${spoken}: no checks rolled up yet.`;
  const down = `${total.down} of ${total.checks} checks down`;
  if (total.medianMs === null) return `${region}, ${spoken}: no responses; ${down}.`;
  const peak = rows.reduce<Point | undefined>(
    (best, p) => (p.p95Ms !== null && (best?.p95Ms ?? -1) < p.p95Ms ? p : best),
    undefined,
  );
  const highest =
    peak?.p95Ms != null
      ? ` Highest ${per} p95: ${latency(peak.p95Ms)} at ${spanLabel(peak.at)}.`
      : "";
  return `${region}, ${spoken}: median ${latency(total.medianMs)}, p95 ${ms(total.p95Ms)}, slowest ${ms(total.maxMs)}; ${down}.${highest}`;
}

/**
 * One region's chart with its numbers in words under it, and the same points as a table on
 * request: the chart is a picture of what the sentence and the table say.
 */
export function RegionPanel({
  region,
  keys,
  unit,
  points,
  total,
  spoken,
  yMax,
  incidents,
  tick,
  step,
  hover,
  onHover,
}: {
  region: string;
  keys: readonly string[];
  unit: number;
  points: readonly (Point | undefined)[];
  total: Total | undefined;
  /** "last 7 days" */
  spoken: string;
  yMax: number;
  incidents: readonly { from: number; to: number }[];
  tick: (ms: number) => string;
  step: number;
  hover: Hover | undefined;
  onHover: (hover: Hover | undefined) => void;
}) {
  const [table, setTable] = useState(false);
  const rows = points.filter((p): p is Point => p !== undefined);
  const per = unit < 86_400_000 ? "hourly" : "daily";
  const hovered = hover ? points[hover.index] : undefined;
  const id = `chart-${region}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-[16px] font-semibold">
        {region}
      </h3>
      <div className="relative">
        <RegionChart
          keys={keys}
          unit={unit}
          points={points}
          yMax={yMax}
          incidents={incidents}
          label={`Response times in ${region}, ${spoken}: median solid, p95 dashed`}
          describedBy={`${id}-words`}
          tick={tick}
          step={step}
          onHover={onHover}
        />
        {hovered && hover && <Readout point={hovered} hover={hover} />}
      </div>
      <p id={`${id}-words`} className="max-w-[72ch] text-[14px]">
        {sentence(region, spoken, per, total, rows)}
      </p>
      <div>
        <Button variant="quiet" aria-expanded={table} onClick={() => setTable(!table)}>
          {table ? "Hide table" : "Show as table"}
        </Button>
      </div>
      {table && (
        <DataTable
          label={`${region}, ${spoken}, each ${per === "hourly" ? "hour" : "day"}`}
          data={rows.map((p) => ({ ...p, id: p.at }))}
          columns={columns}
        />
      )}
    </section>
  );
}
