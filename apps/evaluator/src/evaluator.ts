import {
  type CheckResult,
  type MonitorsFile,
  type MonitorTransitioned,
  probeMessage,
  transitionIdempotencyKey,
} from "@galena/contracts";
import {
  evaluate,
  initialDetectionState,
  inMaintenance,
  nextCanary,
  type WorkflowEngine,
} from "@galena/core";
import {
  type MonitorRecord,
  type RegionHealth,
  type Store,
  VersionConflictError,
} from "./store.ts";

export type SqsRecord = { messageId: string; body: string };

export type EvaluatorDeps = {
  store: Store;
  loadConfig: () => Promise<MonitorsFile>;
  engine: WorkflowEngine;
  /** The probe regions whose canaries decide who counts toward the quorum. */
  regions: readonly string[];
  /** When a result is evaluated: the clock in production, fixed per result in tests. */
  now: (result: CheckResult) => Date;
  onError: (record: SqsRecord, error: unknown) => void;
};

type Context = {
  monitors: Map<string, MonitorsFile["monitors"][number]>;
  health: Map<string, RegionHealth>;
};

/**
 * One SQS FIFO batch, in order. A failed message fails everything after it too, so nothing
 * overtakes it; SQS redelivers them and the per-region `applied` minute skips what already
 * went through.
 */
export async function processBatch(records: readonly SqsRecord[], deps: EvaluatorDeps) {
  const file = await deps.loadConfig();
  const context: Context = {
    monitors: new Map(file.monitors.map((m) => [m.id, m])),
    health: await deps.store.getRegionHealth(deps.regions),
  };
  const outcome = {
    batchItemFailures: [] as { itemIdentifier: string }[],
    transitions: [] as MonitorTransitioned[],
    insufficientRegions: 0,
  };
  for (const [i, record] of records.entries()) {
    try {
      const done = await processRecord(record, deps, context);
      if (done.transition) outcome.transitions.push(done.transition);
      if (done.insufficientRegions) outcome.insufficientRegions++;
    } catch (error) {
      deps.onError(record, error);
      outcome.batchItemFailures = records.slice(i).map((r) => ({ itemIdentifier: r.messageId }));
      break;
    }
  }
  return outcome;
}

async function processRecord(
  record: SqsRecord,
  { store, engine, now }: EvaluatorDeps,
  { monitors, health }: Context,
): Promise<{ transition?: MonitorTransitioned; insufficientRegions?: boolean }> {
  const message = probeMessage.parse(JSON.parse(record.body));

  if (message.kind === "canary") {
    const { region, scheduledAt, passed } = message.canary;
    const at = Date.parse(scheduledAt);
    const current = health.get(region) ?? { excluded: false, passes: 0, lastScheduledAt: 0 };
    if (at <= current.lastScheduledAt) return {};
    const next = { ...nextCanary(current, passed), lastScheduledAt: at };
    await store.putRegionHealth(region, next);
    health.set(region, next);
    return {};
  }

  const result = message.result;
  const monitor = monitors.get(result.monitorId);
  if (!monitor) return {}; // deleted or disabled after the probe read the config
  await store.putResult(result);

  const stored = await store.getMonitor(result.monitorId);
  const current: MonitorRecord = stored ?? {
    detection: initialDetectionState(),
    version: 0,
    applied: {},
    pending: [],
  };
  const expected = stored ? stored.version : null;
  // Left by a crash or a failed trigger; the idempotency key makes a repeat a no-op.
  await triggerAll(engine, current.pending);

  const at = Date.parse(result.scheduledAt);
  if ((current.applied[result.region] ?? 0) >= at) {
    if (current.pending.length > 0) {
      await store.putMonitor(
        result.monitorId,
        { ...current, version: current.version + 1, pending: [] },
        expected,
      );
    }
    return {}; // redelivered: this minute already counted for this region
  }

  const excludedRegions = new Set(
    [...health].filter(([, h]) => h.excluded).map(([region]) => region),
  );
  const evaluation = evaluate(current.detection, result, monitor.detection, {
    clock: { now: () => now(result) },
    excludedRegions,
    inMaintenance: inMaintenance(monitor.maintenance, new Date(result.scheduledAt)),
  });
  const t = evaluation.transition;
  const transition: MonitorTransitioned | undefined = t
    ? {
        id: result.eventId,
        type: "monitor.transitioned",
        occurredAt: new Date(t.at).toISOString(),
        workspaceId: monitor.workspaceId,
        data: {
          monitorId: monitor.id,
          from: t.from,
          to: t.to,
          transitionSeq: t.seq,
          suppressed: t.suppressed,
        },
      }
    : undefined;
  const next: MonitorRecord = {
    detection: evaluation.next,
    version: current.version + 1,
    applied: { ...current.applied, [result.region]: at },
    pending: transition ? [transition] : [],
  };
  // Written before the trigger, so a crash between the two leaves the transition pending.
  await store.putMonitor(result.monitorId, next, expected);
  if (transition) {
    await triggerAll(engine, [transition]);
    try {
      await store.putMonitor(
        result.monitorId,
        { ...next, version: next.version + 1, pending: [] },
        next.version,
      );
    } catch (error) {
      // Lost the race: the next delivery triggers the same key again, which is harmless.
      if (!(error instanceof VersionConflictError)) throw error;
    }
  }
  return {
    ...(transition ? { transition } : {}),
    insufficientRegions: evaluation.insufficientRegions,
  };
}

async function triggerAll(engine: WorkflowEngine, transitions: readonly MonitorTransitioned[]) {
  for (const transition of transitions) {
    await engine.trigger("monitor.state-changed", transition, {
      idempotencyKey: transitionIdempotencyKey(transition),
      tags: [`event:${transition.id}`, `monitor:${transition.data.monitorId}`],
    });
  }
}
