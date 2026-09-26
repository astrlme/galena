import {
  type CanaryResult,
  type CheckResult,
  type EventId,
  type HttpCheck,
  httpCheck,
  type MonitorsFile,
  type ProbeMessage,
} from "@galena/contracts";
import type { HttpOutcome } from "@galena/integrations/net";
import pLimit from "p-limit";

/** Checks in flight at once; the 50 s Lambda budget fits five rounds of 10 s timeouts. */
const CONCURRENCY = 50;
/** SQS SendMessageBatch takes at most 10 entries. */
const BATCH_SIZE = 10;

export type ProbeDeps = {
  region: string;
  canaryUrl: string;
  check: (check: HttpCheck) => Promise<HttpOutcome>;
  /** Sends one batch of up to 10 messages; throws if any entry failed. */
  send: (batch: ProbeMessage[]) => Promise<void>;
  newEventId: () => EventId;
  now: () => Date;
};

/**
 * One scheduled run in one region: the canary and every monitor, checked once each, then
 * reported in FIFO batches. `scheduledAt` comes from the Scheduler, never the clock, so a slow
 * or retried run keeps its minute and its deduplication ids.
 */
export async function runProbe(file: MonitorsFile, scheduledAt: string, deps: ProbeDeps) {
  const minute = new Date(Math.floor(Date.parse(scheduledAt) / 60_000) * 60_000).toISOString();
  const limit = pLimit(CONCURRENCY);
  const run = async (check: HttpCheck): Promise<HttpOutcome> => {
    try {
      return await deps.check(check);
    } catch {
      // One broken check must not lose the other results of this minute.
      const error = { code: "probe_failed" as const, message: "The check crashed in the probe." };
      return { status: "error", httpStatus: null, latencyMs: null, phases: null, error };
    }
  };

  const [canaryOutcome, ...outcomes] = await Promise.all([
    limit(() => run(httpCheck.parse({ url: deps.canaryUrl }))),
    ...file.monitors.map((monitor) => limit(() => run(monitor.http))),
  ]);
  const canary: CanaryResult = {
    region: deps.region,
    scheduledAt: minute,
    passed: canaryOutcome?.status === "up",
    eventId: deps.newEventId(),
  };
  const results = file.monitors.map(
    (monitor, i): CheckResult => ({
      monitorId: monitor.id,
      region: deps.region,
      scheduledAt: minute,
      checkedAt: deps.now().toISOString(),
      ...(outcomes[i] as HttpOutcome),
      eventId: deps.newEventId(),
    }),
  );

  const messages: ProbeMessage[] = [
    { kind: "canary", canary },
    ...results.map((result) => ({ kind: "check" as const, result })),
  ];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await deps.send(messages.slice(i, i + BATCH_SIZE));
  }
  return { canary, results };
}
