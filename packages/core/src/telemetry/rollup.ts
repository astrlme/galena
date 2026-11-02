import type { CheckStatus } from "@galena/contracts";
import { type Histogram, histogramOf, mergeHistograms } from "./histogram.ts";

/** One raw check result as a rollup reads it. */
export type RawCheck = {
  region: string;
  scheduledAt: string;
  status: CheckStatus;
  latencyMs: number | null;
  phases: { dns: number; connect: number; tls: number | null; ttfb: number; total: number } | null;
};

/** The monitor's minutes: those it was checked in, and those a quorum of regions saw it down. */
export type MinuteCounts = { minutes: number; down: number };

/** A sum and how many values went into it, so means add up across hours and days. */
export type Mean = { sum: number; count: number };

/**
 * One region's checks over a span. Latency counts answers only (up and degraded): a fast failure
 * isn't a wait anyone had. Only the total time gets a histogram, for its median and p95; the
 * phases keep their means, enough to say where a typical check spent its time.
 */
export type RegionRollup = {
  checks: number;
  up: number;
  degraded: number;
  down: number;
  error: number;
  /** The slowest answer, or null without one. */
  maxMs: number | null;
  total: Histogram;
  phases: { dns: Mean; connect: Mean; tls: Mean; ttfb: Mean };
};

const PHASES = ["dns", "connect", "tls", "ttfb"] as const;

function regionRollup(checks: readonly RawCheck[]): RegionRollup {
  const answers = checks.filter((c) => c.status === "up" || c.status === "degraded");
  const latencies = answers.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const mean = (phase: (typeof PHASES)[number]): Mean => {
    const values = answers.flatMap((c) => (c.phases?.[phase] == null ? [] : [c.phases[phase]]));
    return { sum: values.reduce((a, b) => a + b, 0), count: values.length };
  };
  const count = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
  return {
    checks: checks.length,
    up: count("up"),
    degraded: count("degraded"),
    down: count("down"),
    error: count("error"),
    maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
    total: histogramOf(latencies),
    phases: { dns: mean("dns"), connect: mean("connect"), tls: mean("tls"), ttfb: mean("ttfb") },
  };
}

/**
 * Rolls one span of a monitor's checks up. A minute is down when at least `quorum` regions
 * failed it, even one detection let pass because it waits for failures in a row. A probe's own
 * error is no answer, so a minute of only errors is not counted at all.
 */
export function rollUp(checks: readonly RawCheck[], quorum: number): Rollup {
  const byRegion = Map.groupBy(checks, (c) => c.region);
  const regions = new Map([...byRegion].map(([region, cs]) => [region, regionRollup(cs)]));
  const byMinute = new Map<string, { answered: number; down: number }>();
  for (const c of checks) {
    if (c.status === "error") continue;
    const m = byMinute.get(c.scheduledAt) ?? { answered: 0, down: 0 };
    m.answered += 1;
    if (c.status === "down") m.down += 1;
    byMinute.set(c.scheduledAt, m);
  }
  const minutes: MinuteCounts = { minutes: byMinute.size, down: 0 };
  for (const m of byMinute.values()) if (m.down >= quorum) minutes.down += 1;
  return { regions, minutes };
}

/** A span of one monitor: each region's rollup, and the monitor's minutes. */
export type Rollup = { regions: Map<string, RegionRollup>; minutes: MinuteCounts };

/** Two spans that share no minute together: a day from its hours. */
export function mergeRollups(a: Rollup, b: Rollup): Rollup {
  const regions = new Map(a.regions);
  for (const [region, rollup] of b.regions) {
    const sofar = regions.get(region);
    regions.set(region, sofar ? mergeRegions(sofar, rollup) : rollup);
  }
  return { regions, minutes: mergeMinutes(a.minutes, b.minutes) };
}

const addMean = (a: Mean, b: Mean): Mean => ({ sum: a.sum + b.sum, count: a.count + b.count });

/** Two spans of one region together: a day from its hours. */
export function mergeRegions(a: RegionRollup, b: RegionRollup): RegionRollup {
  return {
    checks: a.checks + b.checks,
    up: a.up + b.up,
    degraded: a.degraded + b.degraded,
    down: a.down + b.down,
    error: a.error + b.error,
    maxMs: a.maxMs === null ? b.maxMs : b.maxMs === null ? a.maxMs : Math.max(a.maxMs, b.maxMs),
    total: mergeHistograms(a.total, b.total),
    phases: {
      dns: addMean(a.phases.dns, b.phases.dns),
      connect: addMean(a.phases.connect, b.phases.connect),
      tls: addMean(a.phases.tls, b.phases.tls),
      ttfb: addMean(a.phases.ttfb, b.phases.ttfb),
    },
  };
}

/** Two spans' minutes together; spans never share a minute. */
export const mergeMinutes = (a: MinuteCounts, b: MinuteCounts): MinuteCounts => ({
  minutes: a.minutes + b.minutes,
  down: a.down + b.down,
});
