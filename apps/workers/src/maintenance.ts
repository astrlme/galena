import {
  eventId,
  type MaintenanceEventType,
  maintenanceEventData,
  type OutboxId,
  workspaceId,
} from "@galena/contracts";
import { type Clock, type Maintenance, maintenanceStep } from "@galena/core";
import { type Db, maintenanceRepository, recordChange } from "@galena/db";
import { v7 } from "uuid";
import { z } from "zod";

/** What `maintenance.lifecycle` runs: one version of one window. */
export const lifecyclePayload = z.object({
  maintenanceId: maintenanceEventData.shape.maintenanceId,
  workspaceId,
  version: maintenanceEventData.shape.version,
});
export type LifecyclePayload = z.infer<typeof lifecyclePayload>;

export type LifecycleDeps = {
  db: Db;
  clock: Clock;
  /** Durable: the run sleeps without being billed and wakes at `date`. */
  waitUntil: (date: Date) => Promise<void>;
  /** Hands a committed outbox row to `outbox.dispatch`. */
  dispatch: (outboxId: OutboxId) => Promise<void>;
};

/**
 * Starts the window at startsAt and completes it at endsAt. Each wake reads the window again, so
 * an edit (a newer version) or a cancel stops this run: the newer version has its own run.
 */
export async function runMaintenance(
  { maintenanceId, workspaceId, version }: LifecyclePayload,
  deps: LifecycleDeps,
): Promise<"completed" | "superseded"> {
  const windows = maintenanceRepository(deps.db);
  for (;;) {
    const window = await windows.findById(workspaceId, maintenanceId);
    if (!window || window.version !== version) return "superseded";
    if (window.status === "completed") return "completed";
    const step = maintenanceStep(window, deps.clock.now());
    if (!step) {
      await deps.waitUntil(window.status === "scheduled" ? window.startsAt : window.endsAt);
      continue;
    }
    const outboxId = await deps.db.transaction(async (tx) => {
      const moved = await maintenanceRepository(tx).transition(
        workspaceId,
        maintenanceId,
        { version, status: window.status },
        { status: step.to },
      );
      return moved ? recordChange(tx, systemChange(window, step.event, step.to, deps.clock)) : null;
    });
    // Known limit: if this trigger fails, the retry finds the window already moved and the
    // row stays pending; nothing sweeps pending rows yet.
    if (outboxId) await deps.dispatch(outboxId);
  }
}

function systemChange(
  window: Maintenance,
  type: MaintenanceEventType,
  status: Maintenance["status"],
  clock: Clock,
) {
  return {
    workspaceId: window.workspaceId,
    actorUserId: null,
    action: type,
    targetType: "maintenance",
    targetId: window.id,
    event: {
      id: eventId.parse(v7()),
      type,
      occurredAt: clock.now().toISOString(),
      workspaceId: window.workspaceId,
      data: { maintenanceId: window.id, version: window.version, status },
    },
  };
}

export type LifecycleRuns = {
  /** Starts (or finds, by idempotency key) the run and returns its id. */
  start: (payload: LifecyclePayload, idempotencyKey: string) => Promise<string>;
  cancel: (runId: string) => Promise<void>;
};

const maintenanceEvent = z.object({ workspaceId, data: maintenanceEventData });

/**
 * The dispatcher's part: a scheduled window (new or edited) gets a run for its version, keyed
 * `mnt:{id}:{version}`, and the run it replaces is cancelled; a cancelled window loses its run.
 */
export async function steerMaintenance(
  type: "maintenance.scheduled" | "maintenance.cancelled",
  payload: unknown,
  { db, runs }: { db: Db; runs: LifecycleRuns },
) {
  const { workspaceId, data } = maintenanceEvent.parse(payload);
  const windows = maintenanceRepository(db);
  const window = await windows.findById(workspaceId, data.maintenanceId);
  if (!window) return;
  // Cancelling is tidiness: a superseded run finds the newer version when it wakes and stops.
  const stop = (runId: string | null) => (runId ? runs.cancel(runId).catch(() => {}) : undefined);
  if (type === "maintenance.cancelled") return stop(window.runId);
  if (window.version !== data.version) return; // edited again; that edit's event starts its run
  const runId = await runs.start(
    { maintenanceId: window.id, workspaceId, version: window.version },
    `mnt:${window.id}:${window.version}`,
  );
  if (window.runId !== runId) await stop(window.runId);
  await windows.setRunId(window.id, window.version, runId);
}
