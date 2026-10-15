import { createHash } from "node:crypto";
import { laneOf } from "./lanes.ts";

/** The deployment's two FIFO queues: HTML builds apart, so a slow build delays no other job. */
export type JobQueues = Record<"jobs" | "builds", { url: string; arn: string }>;

/** What every job message carries; the key keeps two schedules' bodies apart for dedup. */
export type JobMessage = { job: string; key: string; payload: unknown };

export type JobRequest =
  | { kind: "send"; queueUrl: string; groupId: string; dedupId: string; body: string }
  | { kind: "schedule"; name: string; at: string; queueArn: string; groupId: string; body: string };

/**
 * How one job reaches its queue: sent now, or a one-time schedule for `at`. The name and the
 * deduplication id hash the job with its key (64 hex characters, within both services' limits),
 * so one key repeated is one message, or one schedule, for that job.
 */
export function toRequest(
  job: string,
  payload: unknown,
  { idempotencyKey: key, at }: { idempotencyKey: string; at?: Date },
  now: Date,
  queues: JobQueues,
): JobRequest {
  const queue = job === "page.rebuild-html" ? queues.builds : queues.jobs;
  const id = createHash("sha256").update(`${job}\n${key}`).digest("hex");
  const groupId = laneOf(job, key);
  const body = JSON.stringify({ job, key, payload } satisfies JobMessage);
  if (!at || at <= now) return { kind: "send", queueUrl: queue.url, groupId, dedupId: id, body };
  // Scheduler takes whole seconds in UTC; rounding up keeps a deadline from firing early.
  const seconds = new Date(Math.ceil(at.getTime() / 1000) * 1000);
  return {
    kind: "schedule",
    name: id,
    at: seconds.toISOString().slice(0, 19),
    queueArn: queue.arn,
    groupId,
    body,
  };
}
