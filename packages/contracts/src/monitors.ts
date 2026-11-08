import { z } from "zod";
import { changeData } from "./components.ts";
import {
  checkErrorCodes,
  checkStatuses,
  componentStatuses,
  downStatuses,
  monitorStates,
  monitorTypes,
  publishPolicies,
} from "./enums.ts";
import { eventEnvelope } from "./events.ts";
import { tlsCertificate } from "./expiries.ts";
import { heartbeatSchedule, heartbeatSettings } from "./heartbeats.ts";
import { componentId, eventId, monitorId, workspaceId } from "./ids.ts";

export const awsRegion = z
  .string()
  .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, "Use an AWS region name such as eu-west-1.");

/** What an HTTP check requests and accepts. Private addresses are refused later, after DNS. */
export const httpCheck = z.object({
  url: z
    .url({ protocol: /^https?$/, error: "Use an http:// or https:// URL." })
    // An "@" before the path means user:password in the authority. A string test, so
    // contracts needs no URL global (packages/core has none).
    .refine(
      (url) => !/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(url),
      "Don't put credentials in the URL.",
    ),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  /** Accepted status codes; any 2xx when absent. */
  expectedStatus: z.array(z.int().min(100).max(599)).min(1).max(20).optional(),
  /** Text the response body must contain. */
  keyword: z.string().min(1).max(200).optional(),
  timeoutMs: z.int().min(1_000).max(10_000).default(10_000),
  followRedirects: z.boolean().default(true),
});
export type HttpCheck = z.infer<typeof httpCheck>;

/** Per-monitor detection tuning; the defaults suit most HTTP endpoints. */
export const detectionSettings = z.object({
  /** Consecutive failures before a region counts as failing. */
  failThreshold: z.int().min(1).max(10).default(2),
  /** Consecutive successes before a region counts as healthy again. */
  recoverThreshold: z.int().min(1).max(10).default(3),
  /** Failing regions needed for DOWN. */
  quorum: z.int().min(1).max(5).default(2),
  /** Median latency above this for 3 checks means DEGRADED; null turns it off. */
  degradedLatencyMs: z.int().min(50).max(60_000).nullable().default(null),
  /** A region silent for this many intervals leaves the quorum. */
  staleAfterIntervals: z.int().min(1).max(10).default(3),
  flapWindowMinutes: z.int().min(5).max(240).default(30),
  /** More transitions than this inside the window means FLAPPING. */
  flapMaxTransitions: z.int().min(2).max(20).default(4),
  /** Time a monitor stays steady before RECOVERING resolves, and down before FLAPPING ends. */
  stableMinutes: z.int().min(1).max(240).default(15),
  /** Skip RECOVERING: a recovered monitor goes from down straight to up. */
  recoverAtOnce: z.boolean().default(false),
});
export type DetectionSettings = z.infer<typeof detectionSettings>;

/**
 * A heartbeat has no regions to vote: one late check-in is down, and the next one is up again
 * at once, since it is all the evidence there will be until the next. Flapping still holds for
 * `stableMinutes` before it gives way to down. The API stores these for every heartbeat monitor
 * whatever the request says.
 */
export const heartbeatDetection: DetectionSettings = detectionSettings.parse({
  failThreshold: 1,
  recoverThreshold: 1,
  quorum: 1,
  recoverAtOnce: true,
});

export const monitorConfig = z.object({
  id: monitorId,
  workspaceId,
  componentId: componentId.nullable(),
  name: z.string().trim().min(1, "Enter a name.").max(100, "Keep the name under 100 characters."),
  type: z.enum(monitorTypes),
  /** Set for `http` monitors only. */
  http: httpCheck.nullable().default(null),
  /** Set for `heartbeat` monitors only. */
  heartbeat: heartbeatSettings.nullable().default(null),
  publishPolicy: z.enum(publishPolicies).default("approve"),
  downStatus: z.enum(downStatuses).default("major_outage"),
  // prefault, not default: a missing object must still get its fields' defaults.
  detection: detectionSettings.prefault({}),
  enabled: z.boolean().default(true),
});
export type MonitorConfig = z.infer<typeof monitorConfig>;

/** What the dashboard and API clients send to create or replace a monitor. */
export const monitorInput = monitorConfig
  .omit({ id: true, workspaceId: true })
  .extend({
    componentId: componentId.nullable().default(null),
    type: z.enum(monitorTypes).default("http"),
    heartbeat: heartbeatSchedule.nullable().default(null),
  })
  .refine((m) => m.type !== "http" || m.http !== null, {
    message: "Enter the URL to check.",
    path: ["http"],
  })
  .refine((m) => m.type !== "heartbeat" || m.heartbeat !== null, {
    message: "Say how often the job checks in.",
    path: ["heartbeat"],
  })
  .refine((m) => (m.type === "http" ? m.heartbeat : m.http) === null, {
    message: "Send only the settings of the monitor's own type.",
    path: ["type"],
  });
export type MonitorInput = z.infer<typeof monitorInput>;

export const monitorView = monitorConfig.omit({ workspaceId: true });

/** A new monitor; a heartbeat's ping URL is in this answer only. */
export const monitorCreated = monitorView.extend({ pingUrl: z.url().nullable() });

/** A monitor was created, replaced or deleted; `monitors.json` needs writing again. */
export const monitorChanged = eventEnvelope("monitor.changed", changeData);

/**
 * `monitors.json` in the private config bucket: what the probes and the evaluator read instead
 * of the database. Only enabled monitors are written.
 */
export const monitorsFile = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  monitors: z.array(
    monitorConfig
      .pick({
        id: true,
        workspaceId: true,
        type: true,
        http: true,
        heartbeat: true,
        downStatus: true,
        detection: true,
      })
      .extend({
        /** Windows covering the monitor's component: transitions inside are suppressed. */
        maintenance: z
          .array(z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }))
          .default([]),
      }),
  ),
});
export type MonitorsFile = z.infer<typeof monitorsFile>;

const ms = z.number().nonnegative();

/** Undici phase timings in ms; `tls` is null for http:// targets. */
const checkPhases = z.object({ dns: ms, connect: ms, tls: ms.nullable(), ttfb: ms, total: ms });

/**
 * How far back a monitor's response-time chart reaches, written as its tabs read. A duration in a
 * query string, not a domain state, so it isn't one of the snake_case enums.
 */
export const seriesRanges = ["24h", "7d", "30d", "90d"] as const;
export type SeriesRange = (typeof seriesRanges)[number];

/** Why a check failed, in the probe's words: never a response body or a secret. */
export const checkError = z.object({ code: z.enum(checkErrorCodes), message: z.string().max(500) });

/** One probe's outcome for one monitor at one scheduled minute, sent through SQS FIFO. */
export const checkResult = z
  .object({
    monitorId,
    region: awsRegion,
    /** The Scheduler's minute; the deduplication id comes from it. */
    scheduledAt: z.iso.datetime(),
    checkedAt: z.iso.datetime(),
    status: z.enum(checkStatuses),
    httpStatus: z.int().min(100).max(599).nullable(),
    latencyMs: ms.nullable(),
    phases: checkPhases.nullable(),
    error: checkError.nullable(),
    /** HTTPS only, once the handshake completed; absent from older probes' results. */
    certificate: tlsCertificate.optional(),
    /** Correlation id from probe to delivery. */
    eventId,
  })
  .refine((r) => (r.status === "down" || r.status === "error") === (r.error !== null), {
    message: "Down and error results carry an error; up and degraded results don't.",
    path: ["error"],
  });
export type CheckResult = z.infer<typeof checkResult>;

/** One region's result for one scheduled minute, as the dashboard shows it. */
export const recentResult = z.object({
  region: awsRegion,
  scheduledAt: z.iso.datetime(),
  status: z.enum(checkStatuses),
  latencyMs: ms.nullable(),
});
export type RecentResult = z.infer<typeof recentResult>;

/**
 * A monitor's last day and month at a glance, written by the hourly rollup (`MON#<id>` /
 * `SUMMARY`) so a list reads one small item per monitor.
 */
export const monitorSummary = z.object({
  /** The last whole hour it covers, UTC: `YYYY-MM-DDTHH`. */
  through: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/),
  /** The 24 hours to `through`, oldest first: the median answer over all regions, null for an hour without one. */
  hourlyMedianMs: z.array(ms.nullable()).length(24),
  /** Those 24 hours' p95 over all regions' answers. */
  p95Ms: ms.nullable(),
  /** The 29 days before `through`'s day and that day to `through`: minutes checked and minutes a quorum saw down. */
  minutes: z.int().nonnegative(),
  minutesDown: z.int().nonnegative(),
});
export type MonitorSummary = z.infer<typeof monitorSummary>;

/** A monitor's detection state, its newest results and its summary, read from telemetry. */
export const monitorTelemetry = z.object({
  id: monitorId,
  state: z.enum(monitorStates),
  /** The component status the state maps to; null while detection has no opinion yet. */
  status: z.enum(componentStatuses).nullable(),
  /** When the monitor entered its state; null before its first check. */
  since: z.iso.datetime().nullable(),
  /** Newest first: the last scheduled minutes asked for (60 by default), one entry per region that reported. */
  results: z.array(recentResult),
  /** Null until the hourly rollup has seen its checks. */
  summary: monitorSummary.nullable(),
  /** A heartbeat monitor's newest check-in through its current URL or an older one; null for HTTP monitors and before the first. */
  lastPingAt: z.iso.datetime().nullable(),
});

export type MonitorTelemetry = z.infer<typeof monitorTelemetry>;

/** Pause or resume several monitors at once: up to 50, a workspace's cap, so a whole list fits. */
export const monitorsEnabledInput = z.object({
  ids: z.array(monitorId).min(1).max(50),
  enabled: z.boolean(),
});

const epochMinute = (scheduledAt: string) => Math.floor(Date.parse(scheduledAt) / 60_000);

/** `{monitorId}#{region}#{epochMinute}`: a retried or slow run keeps its minute. */
export function checkDeduplicationId(
  result: Pick<CheckResult, "monitorId" | "region" | "scheduledAt">,
): string {
  return `${result.monitorId}#${result.region}#${epochMinute(result.scheduledAt)}`;
}

/** Whether a probe region can reach a known-good URL; a failing region leaves the quorum. */
export const canaryResult = z.object({
  region: awsRegion,
  scheduledAt: z.iso.datetime(),
  passed: z.boolean(),
  eventId,
});
export type CanaryResult = z.infer<typeof canaryResult>;

/** One SQS FIFO message from a probe. */
export const probeMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), result: checkResult }),
  z.object({ kind: z.literal("canary"), canary: canaryResult }),
]);
export type ProbeMessage = z.infer<typeof probeMessage>;

/** FIFO order is kept per monitor for checks and per region for canaries. */
export function probeMessageIds(message: ProbeMessage) {
  if (message.kind === "check") {
    return {
      groupId: message.result.monitorId,
      deduplicationId: checkDeduplicationId(message.result),
    };
  }
  const { region, scheduledAt } = message.canary;
  return {
    groupId: `canary#${region}`,
    deduplicationId: `canary#${region}#${epochMinute(scheduledAt)}`,
  };
}

/**
 * The evaluator's transition, the payload of `monitor.state-changed`. The envelope id is the
 * check result's `eventId`, so one id follows the outage from probe to delivery.
 */
export const monitorTransitioned = eventEnvelope(
  "monitor.transitioned",
  z.object({
    monitorId,
    from: z.enum(monitorStates),
    to: z.enum(monitorStates),
    transitionSeq: z.int().min(1),
    /** Inside a maintenance window: record it, but publish and notify nothing. */
    suppressed: z.boolean(),
  }),
);
export type MonitorTransitioned = z.infer<typeof monitorTransitioned>;

/** `mon:{monitorId}:{transitionSeq}`: triggering the same transition twice starts one run. */
export const transitionIdempotencyKey = ({ data }: MonitorTransitioned) =>
  `mon:${data.monitorId}:${data.transitionSeq}`;

// The telemetry table's items as the rollup and the API read them back: parsed, not trusted.
const count = z.int().nonnegative();
const mean = z.object({ sum: z.number().nonnegative(), count });

/** A raw check item (`R#<scheduledAt>#<region>`), the fields a rollup reads. */
export const storedCheck = z.object({
  status: z.enum(checkStatuses),
  latencyMs: ms.nullish(),
  phases: checkPhases.nullish(),
});

/** One region's hour or day (`H#`, `D#`). */
export const storedRegionRollup = z.object({
  checks: count,
  up: count,
  degraded: count,
  down: count,
  error: count,
  maxMs: ms.nullable(),
  total: z.array(count),
  phases: z.object({ dns: mean, connect: mean, tls: mean, ttfb: mean }),
});

/** A monitor's minutes for an hour or a day (`UH#`, `UD#`). */
export const storedMinutes = z.object({ minutes: count, down: count });
