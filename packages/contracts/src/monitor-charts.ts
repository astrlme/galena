import { z } from "zod";
import { seriesSteps } from "./enums.ts";
import { incidentId } from "./ids.ts";
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

/**
 * A whole range as one point: per region, then all regions together (`region: null`). Its
 * histograms are merged, so its p95 is the range's own, not an average of the points'.
 */
export const rangeTotal = seriesPoint.omit({ at: true }).extend({ region: awsRegion.nullable() });

/** An incident the monitor opened that overlaps a chart's range. */
export const chartIncident = z.object({
  id: incidentId,
  title: z.string(),
  startedAt: z.iso.datetime(),
  /** Null while it is open. */
  resolvedAt: z.iso.datetime().nullable(),
});

export const monitorSeries = z.object({
  range: z.enum(seriesRanges),
  step: z.enum(seriesSteps),
  /** The first and last span the range covers, as `at` keys: a chart's whole x axis. */
  from: z.string(),
  to: z.string(),
  points: z.array(seriesPoint),
  totals: z.array(rangeTotal),
  /** The range's minutes checked and minutes a quorum of regions saw it down. */
  uptime: z.object({ minutes: z.int().nonnegative(), minutesDown: z.int().nonnegative() }),
  incidents: z.array(chartIncident),
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
