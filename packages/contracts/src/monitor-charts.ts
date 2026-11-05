import { z } from "zod";
import { seriesSteps } from "./enums.ts";
import { awsRegion, seriesRanges } from "./monitors.ts";

// What a monitor's charts read: its response times and its month.

const ms = z.number().nonnegative();

/** One region's point on a response-time chart: a minute, an hour or a day of its checks. */
export const seriesPoint = z.object({
  /** The span's start, UTC: `YYYY-MM-DDTHH:MM`, `YYYY-MM-DDTHH` or `YYYY-MM-DD`. */
  at: z.string(),
  region: awsRegion,
  checks: z.int().nonnegative(),
  down: z.int().nonnegative(),
  /** Over answers only (up or degraded); null when the span had none. */
  medianMs: ms.nullable(),
  p95Ms: ms.nullable(),
  maxMs: ms.nullable(),
  /** Where a typical answer spent its time. */
  phases: z.object({
    dns: ms.nullable(),
    connect: ms.nullable(),
    tls: ms.nullable(),
    ttfb: ms.nullable(),
  }),
});

export const monitorSeries = z.object({
  range: z.enum(seriesRanges),
  step: z.enum(seriesSteps),
  points: z.array(seriesPoint),
});

/** A calendar month, UTC: `2026-11`. */
export const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Use a month such as 2026-11.");

/** A month of one monitor: minutes checked, minutes a quorum of regions saw it down, incidents it opened. */
export const monitorUptime = z.object({
  month,
  minutes: z.int().nonnegative(),
  minutesDown: z.int().nonnegative(),
  incidents: z.int().nonnegative(),
});
