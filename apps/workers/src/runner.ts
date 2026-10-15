import { type ZodType, z } from "zod";

/** Thrown when trying again cannot help: the job fails at once, with its failure hook. */
export class FinalError extends Error {}

/** `attempts` counts the first run; each wait is `minMs × factor^(attempt − 1)`, at most `maxMs`. */
export type Retry = { attempts: number; minMs: number; maxMs: number; factor: number };

/**
 * A background job, the same on every engine: its payload schema, its retries, what it does, and
 * what to record once it has failed for good.
 */
export type Job<P = unknown> = {
  name: string;
  payload: ZodType<P>;
  retry?: Retry;
  run: (payload: P, ctx: { attempt: number }) => Promise<unknown>;
  onFailure?: (payload: P, error: unknown) => Promise<void>;
};

export const defineJob = <P>(job: Job<P>): Job<P> => job;

/** What a scheduled job receives: the time it was scheduled for. */
export const cronPayload = z.object({ timestamp: z.iso.datetime() });

export type AttemptResult =
  | { outcome: "done"; result: unknown }
  | { outcome: "retry"; afterMs: number; error: unknown }
  // `recorded`: the job's failure hook ran and kept the failure.
  | { outcome: "failed"; error: unknown; recorded: boolean };

/**
 * One attempt (counted from 1) of a job, for engines that retry by themselves. A payload that
 * doesn't parse fails at once: no attempt can change it.
 */
export async function runAttempt<P>(
  job: Job<P>,
  raw: unknown,
  attempt: number,
): Promise<AttemptResult> {
  const parsed = job.payload.safeParse(raw);
  if (!parsed.success) return { outcome: "failed", error: parsed.error, recorded: false };
  try {
    return { outcome: "done", result: await job.run(parsed.data, { attempt }) };
  } catch (error) {
    const retry = job.retry;
    if (retry && !(error instanceof FinalError) && attempt < retry.attempts) {
      const afterMs = Math.min(retry.maxMs, retry.minMs * retry.factor ** (attempt - 1));
      return { outcome: "retry", afterMs, error };
    }
    // A hook that fails too leaves the failure unrecorded, for the engine to keep some other way.
    const recorded = job.onFailure
      ? await job.onFailure(parsed.data, error).then(
          () => true,
          () => false,
        )
      : false;
    return { outcome: "failed", error, recorded };
  }
}
