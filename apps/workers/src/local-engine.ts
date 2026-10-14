import type { JobEngine } from "@galena/core";
import { laneOf } from "@galena/integrations/jobs";
import { errorFields, log } from "./log.ts";
import { type Job, runAttempt } from "./runner.ts";

// The longest wait setTimeout takes (about 24.8 days); later starts wait in steps.
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Runs the jobs in this process, for local development: one job at a time per lane, each key
 * once, a job started at a time by a timer, retries after their waits. Known limit: nothing
 * survives a restart; the dev process re-arms open drafts, unfinished windows and the outbox
 * when it starts.
 */
export function localEngine(jobs: ReadonlyMap<string, Job<unknown>>): JobEngine {
  const seen = new Set<string>();
  const lanes = new Map<string, Promise<void>>();

  const enqueue = (lane: string, work: () => Promise<void>) => {
    const next = (lanes.get(lane) ?? Promise.resolve()).then(() =>
      work().catch((error: unknown) =>
        log.error("local job crashed", { lane, ...errorFields(error) }),
      ),
    );
    lanes.set(lane, next);
    // Forgets an idle lane; `next` never rejects, the work's errors are caught above.
    void next.then(() => {
      if (lanes.get(lane) === next) lanes.delete(lane);
    });
  };

  const run = async (job: Job<unknown>, payload: unknown, key: string) => {
    for (let attempt = 1; ; attempt++) {
      const result = await runAttempt(job, payload, attempt);
      if (result.outcome === "done") return;
      if (result.outcome === "failed") {
        log.error(`${job.name} failed`, { key, attempt, ...errorFields(result.error) });
        return;
      }
      // The wait holds the lane, as a queue holds a message it will deliver again.
      await new Promise((resolve) => setTimeout(resolve, result.afterMs));
    }
  };

  const startAt = (at: Date, start: () => void) => {
    const wait = at.getTime() - Date.now();
    if (wait <= 0) return start();
    setTimeout(() => startAt(at, start), Math.min(wait, MAX_TIMEOUT));
  };

  const engine: JobEngine = {
    async trigger(task, payload, { idempotencyKey, at }) {
      const job = jobs.get(task);
      if (!job) throw new Error(`No job named ${task}.`);
      const id = `${task} ${idempotencyKey}`;
      if (seen.has(id)) return;
      seen.add(id);
      const start = () =>
        enqueue(laneOf(task, idempotencyKey), () => run(job, payload, idempotencyKey));
      if (at) startAt(at, start);
      else start();
    },
    async triggerAll(task, items) {
      for (const { payload, options } of items) await engine.trigger(task, payload, options);
    },
  };
  return engine;
}

/**
 * Whether a cron pattern names `at`'s minute, in UTC. Minute and hour take a star, a star with
 * a step (every n) or a number; day, month and weekday must be stars, as in every schedule here.
 */
export function cronMatches(pattern: string, at: Date): boolean {
  const [minute = "", hour = "", ...rest] = pattern.split(" ");
  if (rest.length !== 3 || rest.some((field) => field !== "*")) {
    throw new Error(`Only minute and hour are read in "${pattern}"; the other fields must be *.`);
  }
  const field = (spec: string, value: number) =>
    spec === "*" ||
    (spec.startsWith("*/") ? value % Number(spec.slice(2)) === 0 : Number(spec) === value);
  return field(minute, at.getUTCMinutes()) && field(hour, at.getUTCHours());
}

/** Starts each scheduled job at the minutes its pattern names; returns a function that stops them. */
export function startCrons(
  crons: readonly { job: { name: string }; pattern: string }[],
  engine: JobEngine,
): () => void {
  const untilNextMinute = () => 60_000 - (Date.now() % 60_000);
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = Date.now();
    const minute = new Date(now - (now % 60_000));
    const timestamp = minute.toISOString();
    for (const { job, pattern } of crons) {
      if (!cronMatches(pattern, minute)) continue;
      engine
        .trigger(job.name, { timestamp }, { idempotencyKey: `cron:${job.name}:${timestamp}` })
        .catch((error: unknown) =>
          log.error("cron not started", { job: job.name, ...errorFields(error) }),
        );
    }
    timer = setTimeout(tick, untilNextMinute());
  };
  timer = setTimeout(tick, untilNextMinute());
  return () => clearTimeout(timer);
}
