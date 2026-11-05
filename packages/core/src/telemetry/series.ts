import type { SeriesRange, SeriesStep } from "@galena/contracts";
import { assertNever } from "../assert-never.ts";
import { quantileOf } from "./histogram.ts";
import { type Mean, type MinuteCounts, mergeRegions, type RegionRollup } from "./rollup.ts";

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

/**
 * A whole range of rollups as one point, merged before any quantile: the range's own p95, which
 * no average of its points' p95s gives. Null without any.
 */
export function totalOf(rollups: readonly RegionRollup[]): SeriesPoint | null {
  const [first, ...rest] = rollups;
  return first ? pointOf(rest.reduce(mergeRegions, first)) : null;
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

/** A window's first span's start and its last span's end, as instants. */
export function windowSpan({ source, from, to }: SeriesWindow): { from: Date; to: Date } {
  const start = (key: string) =>
    Date.parse(source === "hour" ? `${key}:00:00.000Z` : `${key}T00:00:00.000Z`);
  return {
    from: new Date(start(from)),
    to: new Date(start(to) + (source === "hour" ? HOUR : DAY)),
  };
}

/** A chart point with the span it covers and its region. */
export type PointAt = SeriesPoint & { at: string; region: string };
/** A whole range as one point: for one region, or for all of them together (`null`). */
export type Total = SeriesPoint & { region: string | null };

/**
 * A chart's rollups as its points, oldest first then by region, and its totals: each region's
 * whole range, then all regions together.
 */
export function seriesOf(
  rollups: readonly { at: string; region: string; rollup: RegionRollup }[],
): {
  points: PointAt[];
  totals: Total[];
} {
  const points = rollups
    .map(({ at, region, rollup }) => ({ at, region, ...pointOf(rollup) }))
    .toSorted((a, b) => a.at.localeCompare(b.at) || a.region.localeCompare(b.region));
  const byRegion = Map.groupBy(rollups, (r) => r.region);
  const totals: Total[] = [...byRegion.keys()].toSorted().flatMap((region) => {
    const total = totalOf((byRegion.get(region) ?? []).map((r) => r.rollup));
    return total ? [{ region, ...total }] : [];
  });
  const all = totalOf(rollups.map((r) => r.rollup));
  return { points, totals: all ? [...totals, { region: null, ...all }] : totals };
}

/**
 * The 90 days ending `today` (`YYYY-MM-DD`), oldest first: each from its day rollup, or, until
 * that is written after midnight, from its hours; a day with neither has no data.
 */
export function ninetyDays(
  today: string,
  days: ReadonlyMap<string, MinuteCounts>,
  hours: ReadonlyMap<string, MinuteCounts>,
): { date: string; minutes: number; minutesDown: number }[] {
  const end = Date.parse(`${today}T00:00:00.000Z`);
  return Array.from({ length: 90 }, (_, i) => {
    const date = dayKey(end - (89 - i) * DAY);
    const counted = days.get(date) ?? hours.get(date) ?? { minutes: 0, down: 0 };
    return { date, minutes: counted.minutes, minutesDown: counted.down };
  });
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
