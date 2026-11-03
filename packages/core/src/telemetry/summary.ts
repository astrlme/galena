import type { MonitorSummary } from "@galena/contracts";
import { type Histogram, histogramOf, mergeHistograms, quantileOf } from "./histogram.ts";
import type { MinuteCounts, RegionRollup } from "./rollup.ts";
import { dayKey, hourKey } from "./series.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * What a summary to the hour starting at `last` reads, besides that hour itself: the 23 hours
 * before it, the 29 whole days before its day, and its day's earlier hours (none at midnight).
 */
export function summaryWindow(last: number) {
  const day = Math.floor(last / DAY) * DAY;
  return {
    hours: { from: hourKey(last - 23 * HOUR), to: hourKey(last - HOUR) },
    days: { from: dayKey(day - 29 * DAY), to: dayKey(day - DAY) },
    today: last > day ? { from: hourKey(day), to: hourKey(last - HOUR) } : null,
  };
}

const rounded = (ms: number | null) => (ms === null ? null : Math.round(ms));

/**
 * A monitor's last 24 hours and 30 days at a glance, from its region hours and its minute
 * counts. Regions are merged before any quantile, so a slow region weighs by its answers.
 */
export function summarize(
  last: number,
  hours: readonly { at: string; rollup: RegionRollup }[],
  minutes: readonly MinuteCounts[],
): MonitorSummary {
  const slots = Array.from({ length: 24 }, (_, i) => hourKey(last - (23 - i) * HOUR));
  const byHour = new Map<string, Histogram>(slots.map((at) => [at, histogramOf([])]));
  for (const { at, rollup } of hours) {
    const sofar = byHour.get(at);
    if (sofar) byHour.set(at, mergeHistograms(sofar, rollup.total));
  }
  const all = [...byHour.values()].reduce(mergeHistograms);
  return {
    through: hourKey(last),
    hourlyMedianMs: slots.map((at) => rounded(quantileOf(byHour.get(at) ?? [], 0.5))),
    p95Ms: rounded(quantileOf(all, 0.95)),
    minutes: minutes.reduce((sum, m) => sum + m.minutes, 0),
    minutesDown: minutes.reduce((sum, m) => sum + m.down, 0),
  };
}
