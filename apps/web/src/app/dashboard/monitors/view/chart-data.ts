import type { SeriesRange } from "@galena/contracts";
import type { paths } from "../../../../lib/api-schema.ts";
import { SHORT_MONTHS, two } from "../../../../lib/time.ts";

export type Series =
  paths["/v1/monitors/{id}/series"]["get"]["responses"][200]["content"]["application/json"];
export type Point = Series["points"][number];
export type Total = Series["totals"][number];
/** The span under the pointer in every chart, its x and the plot's width. */
export type Hover = { index: number; left: number; width: number };

/** The y axis's width, which the hover readout's position counts from. */
export const AXIS = 64;
/** The hover readout's width. */
export const READOUT = 208;

/** Seconds between a chart's x ticks, per range. */
export const TICKS: Record<SeriesRange, number> = {
  "24h": 3 * 3600,
  "7d": 86_400,
  "30d": 7 * 86_400,
  "90d": 14 * 86_400,
};

/** An x tick's label: the hour for a day's chart, the date otherwise. */
export const tickLabel = (range: SeriesRange) =>
  range === "24h"
    ? (ms: number) => `${two(new Date(ms).getUTCHours())}:00`
    : (ms: number) => `${new Date(ms).getUTCDate()} ${SHORT_MONTHS[new Date(ms).getUTCMonth()]}`;

/** A shared scale with room above the highest line, rounded to 1, 2 or 5 of a power of ten. */
export function niceMax(points: readonly Point[]) {
  const top = Math.max(100, ...points.map((p) => p.p95Ms ?? p.medianMs ?? 0)) * 1.1;
  const power = 10 ** Math.floor(Math.log10(top));
  return ([1, 2, 5, 10].find((m) => m * power >= top) ?? 10) * power;
}
