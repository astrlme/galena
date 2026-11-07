import type { CheckResult, EventId, MonitorsFile, MonitorTransitioned } from "@galena/contracts";
import { heartbeatCheck } from "@galena/core";
import { type EvaluatorDeps, processBatch, type SqsRecord } from "./evaluator.ts";
import { type Store, VersionConflictError } from "./store.ts";

type HeartbeatResultDeps = {
  store: Pick<Store, "getPings">;
  /** Where the sweep runs, named on each result as a probe names its region. */
  region: string;
  newEventId: () => EventId;
};

/**
 * One scheduled minute of every heartbeat monitor, judged from its newest check-in: what a probe
 * would have reported. The results go through the same detection as HTTP checks, so a heartbeat
 * opens, drafts and resolves incidents like any monitor. A monitor with no check-in yet gets no
 * result and keeps its state.
 */
export async function heartbeatResults(
  file: MonitorsFile,
  scheduledAt: string,
  deps: HeartbeatResultDeps,
): Promise<CheckResult[]> {
  const heartbeats = file.monitors.flatMap(({ id, heartbeat }) =>
    heartbeat ? [{ id, heartbeat }] : [],
  );
  if (heartbeats.length === 0) return [];
  const pings = await deps.store.getPings(heartbeats.map((m) => m.id));
  const minute = new Date(Math.floor(Date.parse(scheduledAt) / 60_000) * 60_000);
  return heartbeats.flatMap(({ id, heartbeat }) => {
    const check = heartbeatCheck(heartbeat, pings.get(id), minute);
    if (!check) return [];
    return [
      {
        monitorId: id,
        region: deps.region,
        scheduledAt: minute.toISOString(),
        // Judged as of the scheduled minute, so a retried sweep reaches the same verdict.
        checkedAt: minute.toISOString(),
        ...check,
        httpStatus: null,
        latencyMs: null,
        phases: null,
        eventId: deps.newEventId(),
      },
    ];
  });
}

/** The results as the evaluator reads queue messages, one per monitor. */
export const asRecords = (results: readonly CheckResult[]): SqsRecord[] =>
  results.map((result) => ({
    messageId: result.monitorId,
    body: JSON.stringify({ kind: "check", result }),
  }));

export type SweepDeps = HeartbeatResultDeps & Omit<EvaluatorDeps, "loadConfig" | "regions">;

/**
 * The scheduled sweep: the heartbeat results, evaluated at once in this process. Nothing else
 * reports on a heartbeat monitor, so there is no queue to keep in order, and each monitor goes
 * through on its own: one that fails doesn't hold up the rest. A version conflict means another
 * run of the same minute got there first. Probe regions' canaries say nothing about check-ins,
 * so none are read. A failed monitor is not retried: the next minute judges it afresh.
 */
export async function sweepHeartbeats(file: MonitorsFile, scheduledAt: string, deps: SweepDeps) {
  const outcome = { transitions: [] as MonitorTransitioned[], failed: 0 };
  const results = await heartbeatResults(file, scheduledAt, deps);
  for (const record of asRecords(results)) {
    const one = await processBatch([record], {
      ...deps,
      loadConfig: async () => file,
      regions: [],
      onError: (failed, error) => {
        if (error instanceof VersionConflictError) return;
        outcome.failed++;
        deps.onError(failed, error);
      },
    });
    outcome.transitions.push(...one.transitions);
  }
  return outcome;
}
