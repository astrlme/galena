import type { SeriesRange, SeriesStep } from "@galena/contracts";
import { assertNever } from "../assert-never.ts";
import { quantileOf } from "./histogram.ts";
import type { Mean, RegionRollup } from "./rollup.ts";

/** One chart point for one region: an hour or a day of its checks. */
export type SeriesPoint = {
  checks: number;
  down: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Where a typical answer spent its time; null for a phase nothing measured. */
  phases: { dns: number | null; connect: number | null; tls: number | null; ttfb: number | null };
};

const meanOf = (m: Mean) => (m.count === 0 ? null : Math.round(m.sum / m.count));
const rounded = (ms: number | null) => (ms === null ? null : Math.round(ms));

export function pointOf(rollup: RegionRollup): SeriesPoint {
  return {
    checks: rollup.checks,
    down: rollup.down,
    medianMs: rounded(quantileOf(rollup.total, 0.5)),
    p95Ms: rounded(quantileOf(rollup.total, 0.95)),
    maxMs: rollup.maxMs,
    phases: {
      dns: meanOf(rollup.phases.dns),
      connect: meanOf(rollup.phases.connect),
      tls: meanOf(rollup.phases.tls),
      ttfb: meanOf(rollup.phases.ttfb),
    },
  };
}

/** Which items a range reads, and their first and last keys (UTC, inclusive). */
export type SeriesWindow = { source: SeriesStep; from: string; to: string };

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const floorTo = (t: number, unit: number) => Math.floor(t / unit) * unit;
const iso = (t: number) => new Date(t).toISOString();

/** Hour keys `YYYY-MM-DDTHH`, day keys `YYYY-MM-DD`. */
export const hourKey = (t: number) => iso(t).slice(0, 13);
export const dayKey = (t: number) => iso(t).slice(0, 10);

/**
 * The window a range reads: a day or a week its whole hours, a month or a quarter its whole days,
 * those the hourly rollup has finished. Hours keep a day small: 24 items per region, where its
 * raw minutes would be 1,440.
 */
export function seriesWindow(range: SeriesRange, now: Date): SeriesWindow {
  const t = now.getTime();
  switch (range) {
    case "24h":
    case "7d": {
      const to = floorTo(t, HOUR) - HOUR;
      const days = range === "24h" ? 1 : 7;
      return { source: "hour", from: hourKey(to - days * DAY + HOUR), to: hourKey(to) };
    }
    case "30d":
    case "90d": {
      const to = floorTo(t, DAY) - DAY;
      const days = range === "30d" ? 30 : 90;
      return { source: "day", from: dayKey(to - (days - 1) * DAY), to: dayKey(to) };
    }
    default:
      return assertNever(range);
  }
}

/**
 * A month (`YYYY-MM`) as instants, for the incidents that started in it, and as its first and
 * last day keys, for its daily minute counts.
 */
export function monthSpan(month: string): {
  from: Date;
  to: Date;
  days: { from: string; to: string };
} {
  const [year = 0, index = 1] = month.split("-").map(Number);
  const from = new Date(Date.UTC(year, index - 1, 1));
  const to = new Date(Date.UTC(year, index, 1));
  return { from, to, days: { from: dayKey(from.getTime()), to: dayKey(to.getTime() - DAY) } };
}
