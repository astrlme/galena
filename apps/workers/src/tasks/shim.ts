import type { JobEngine } from "@galena/core";
import { laneOf } from "@galena/integrations/jobs";
import { AbortTaskRunError, logger, type Queue, schedules, task, tasks } from "@trigger.dev/sdk";
import { setEngine } from "../engine.ts";
import { setLog } from "../log.ts";
import { FinalError, type Job } from "../runner.ts";
import { globalKey } from "./keys.ts";

// Jobs throttled per destination: one delivery at a time per endpoint, so a slow one throttles
// only itself. Every other lane is the job's queue.
const perDestination = new Set(["notify.slack", "notify.webhook"]);
// trigger.dev takes up to this many runs per batch call.
const BATCH = 500;

/** The trigger.dev options for one run: the key made global, `at` as its delay, a lane's key. */
export async function runOptions(
  task: string,
  { idempotencyKey, at }: { idempotencyKey: string; at?: Date },
) {
  return {
    idempotencyKey: await globalKey(idempotencyKey),
    ...(at ? { delay: at } : {}),
    ...(perDestination.has(task) ? { concurrencyKey: laneOf(task, idempotencyKey) } : {}),
  };
}

/** Jobs started from inside a trigger.dev run go back to trigger.dev. */
const triggerDev: JobEngine = {
  async trigger(task, payload, options) {
    await tasks.trigger(task, payload, {
      ...(await runOptions(task, options)),
      ...(options.tags ? { tags: options.tags } : {}),
    });
  },
  async triggerAll(task, jobs) {
    for (let i = 0; i < jobs.length; i += BATCH) {
      await tasks.batchTrigger(
        task,
        await Promise.all(
          jobs.slice(i, i + BATCH).map(async ({ payload, options }) => ({
            payload,
            options: await runOptions(task, options),
          })),
        ),
      );
    }
  },
};
setEngine(triggerDev);
setLog({
  info: (message, fields) => logger.info(message, fields),
  error: (message, fields) => logger.error(message, fields),
});

/** A job as a trigger.dev task, with trigger.dev retrying it by the job's own settings. */
export function shim<P>(job: Job<P>, settings: { queue?: Queue; machine?: "small-2x" } = {}) {
  const { retry } = job;
  return task({
    id: job.name,
    ...settings,
    ...(retry
      ? {
          retry: {
            maxAttempts: retry.attempts,
            factor: retry.factor,
            minTimeoutInMs: retry.minMs,
            maxTimeoutInMs: retry.maxMs,
          },
        }
      : {}),
    run: async (raw: unknown, { ctx }) => {
      const parsed = job.payload.safeParse(raw);
      if (!parsed.success) throw new AbortTaskRunError(`Payload: ${parsed.error.message}`);
      try {
        return await job.run(parsed.data, { attempt: ctx.attempt.number });
      } catch (error) {
        if (error instanceof FinalError) throw new AbortTaskRunError(error.message);
        throw error;
      }
    },
    onFailure: async ({ payload, error }) => {
      const parsed = job.payload.safeParse(payload);
      if (parsed.success) await job.onFailure?.(parsed.data, error);
    },
  });
}

/** A scheduled job as a trigger.dev schedule. */
export function cron(
  { job, pattern }: { job: Job<{ timestamp: string }>; pattern: string },
  settings: { queue?: Queue } = {},
) {
  return schedules.task({
    id: job.name,
    ...settings,
    // Zero window: trigger.dev spreads new schedules across the hour by default, and the sweep
    // and the rollup must share their minute.
    cron: { pattern, window: "0m" },
    run: ({ timestamp }) => job.run({ timestamp: timestamp.toISOString() }, { attempt: 1 }),
  });
}
