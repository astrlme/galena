import type { ComponentStatus } from "@galena/contracts";
import { dayMark } from "../publishing/uptime.ts";
import { type MinuteCounts, mergeMinutes, type RegionRollup } from "./rollup.ts";
import { monthSpan, totalOf } from "./series.ts";

/** A monitor's month as a report reads it. */
export type MonthOf = { minutes: number; minutesDown: number; p95Ms: number | null };

/**
 * A monitor's month from its daily rollups (and today's hours while the month is running): the
 * minutes checked and down, and one p95 over every region's answers, merged before the quantile.
 */
export function monthOf(spans: { minutes: MinuteCounts[]; regions: RegionRollup[] }): MonthOf {
  const { minutes, down } = spans.minutes.reduce(mergeMinutes, { minutes: 0, down: 0 });
  return { minutes, minutesDown: down, p95Ms: totalOf(spans.regions)?.p95Ms ?? null };
}

/** What an SLA target allows a month: minutes it may spend down, and those still unspent. */
export type ErrorBudget = { allowedMinutes: number; leftMinutes: number };

/**
 * `target` (a percentage, to a thousandth) of the minutes checked so far plus `minutesLeft`, the
 * month's minutes still to come. A finished month has none left, so its budget holds exactly
 * when its uptime meets the target; a running one says how much more down time it can take.
 * Below zero once spent.
 */
export function errorBudget(month: MinuteCounts, target: number, minutesLeft: number): ErrorBudget {
  // In thousandths of a percent, so 99.9% of 1,000 minutes allows one, not 0.99999.
  const missable = 100_000 - Math.round(target * 1000);
  const allowedMinutes = Math.floor((missable * (month.minutes + minutesLeft)) / 100_000);
  return { allowedMinutes, leftMinutes: allowedMinutes - month.down };
}

/** Whole minutes of `month` (`YYYY-MM`) still to come at `now`: none once it is over. */
export function minutesLeftIn(month: string, now: Date): number {
  const { from, to } = monthSpan(month);
  const start = Math.max(from.getTime(), now.getTime());
  return Math.max(0, Math.floor((to.getTime() - start) / 60_000));
}

/**
 * A component's days from the uptime rollup as minutes measured and down, the status page's own
 * rule: partial and major outages are down (whole minutes a day), maintenance is not taken out.
 * Measured minutes stay fractional, as the rollup stores them.
 */
export function componentMinutes(
  days: ReadonlyArray<Partial<Record<ComponentStatus, number>>>,
): MinuteCounts {
  let minutes = 0;
  let down = 0;
  for (const day of days) {
    minutes += Object.values(day).reduce((sum, m) => sum + m, 0);
    down += dayMark(day).downMinutes;
  }
  return { minutes, down };
}
