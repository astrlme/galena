import { z } from "zod";
import {
  checkErrorCodes,
  checkStatuses,
  downStatuses,
  monitorTypes,
  publishPolicies,
} from "./enums.ts";
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
  /** Time a monitor stays steady before RECOVERING resolves. */
  stableMinutes: z.int().min(1).max(240).default(15),
});
export type DetectionSettings = z.infer<typeof detectionSettings>;

export const monitorConfig = z.object({
  id: monitorId,
  workspaceId,
  componentId: componentId.nullable(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(monitorTypes),
  http: httpCheck,
  publishPolicy: z.enum(publishPolicies).default("approve"),
  downStatus: z.enum(downStatuses).default("major_outage"),
  // prefault, not default: a missing object must still get its fields' defaults.
  detection: detectionSettings.prefault({}),
  enabled: z.boolean().default(true),
});
export type MonitorConfig = z.infer<typeof monitorConfig>;

/**
 * `monitors.json` in the private config bucket: what the probes and the evaluator read instead
 * of the database. Only enabled monitors are written.
 */
export const monitorsFile = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  monitors: z.array(
    monitorConfig.pick({
      id: true,
      workspaceId: true,
      type: true,
      http: true,
      downStatus: true,
      detection: true,
    }),
  ),
});
export type MonitorsFile = z.infer<typeof monitorsFile>;

const ms = z.number().nonnegative();

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
    /** Undici phase timings in ms; `tls` is null for http:// targets. */
    phases: z.object({ dns: ms, connect: ms, tls: ms.nullable(), ttfb: ms, total: ms }).nullable(),
    error: z.object({ code: z.enum(checkErrorCodes), message: z.string().max(500) }).nullable(),
    /** Correlation id from probe to delivery. */
    eventId,
  })
  .refine((r) => (r.status === "down" || r.status === "error") === (r.error !== null), {
    message: "Down and error results carry an error; up and degraded results don't.",
    path: ["error"],
  });
export type CheckResult = z.infer<typeof checkResult>;

/** `{monitorId}#{region}#{epochMinute}`: a retried or slow run keeps its minute. */
export function checkDeduplicationId(
  result: Pick<CheckResult, "monitorId" | "region" | "scheduledAt">,
): string {
  const epochMinute = Math.floor(Date.parse(result.scheduledAt) / 60_000);
  return `${result.monitorId}#${result.region}#${epochMinute}`;
}
