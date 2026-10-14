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

/** What `maintenance.lifecycle` runs: one version of one window, now or at a wake. */
export const lifecyclePayload = z.object({
  maintenanceId: maintenanceEventData.shape.maintenanceId,
  workspaceId,
  version: maintenanceEventData.shape.version,
  /** For a wake, the time it was asked for. */
  at: z.iso.datetime().optional(),
});
export type LifecyclePayload = z.infer<typeof lifecyclePayload>;

export type LifecycleDeps = {
  db: Db;
  clock: Clock;
  /** Runs this job again at `next.at`. */
  wakeAt: (next: LifecyclePayload & { at: string }, idempotencyKey: string) => Promise<void>;
  /** Hands a committed outbox row to `outbox.dispatch`. */
  dispatch: (outboxId: OutboxId) => Promise<void>;
};

/**
 * Starts the window at startsAt and completes it at endsAt, asking to run again at the next of
 * them, keyed `mnt:{id}:{version}:{status}`. Each run reads the window again, so an edit (a newer
 * version, which has its own run) or a cancel stops this one.
 */
export async function runMaintenance(
  { maintenanceId, workspaceId, version, at }: LifecyclePayload,
  deps: LifecycleDeps,
): Promise<"completed" | "superseded" | "waiting"> {
  const windows = maintenanceRepository(deps.db);
  for (;;) {
    const window = await windows.findById(workspaceId, maintenanceId);
    if (!window || window.version !== version) return "superseded";
    if (window.status === "completed") return "completed";
    // A wake acts as of the time it was asked for: a worker clock a moment behind would
    // otherwise ask again under this run's own key, which starts nothing.
    const now = new Date(Math.max(deps.clock.now().getTime(), at ? Date.parse(at) : 0));
    const step = maintenanceStep(window, now);
    if (!step) {
      const wake = window.status === "scheduled" ? window.startsAt : window.endsAt;
      await deps.wakeAt(
        { maintenanceId, workspaceId, version, at: wake.toISOString() },
        `mnt:${maintenanceId}:${version}:${window.status}`,
      );
      return "waiting";
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
  /** Starts the run once per idempotency key. */
  start: (payload: LifecyclePayload, idempotencyKey: string) => Promise<void>;
};

const maintenanceEvent = z.object({ workspaceId, data: maintenanceEventData });

/**
 * The dispatcher's part: a scheduled window (new or edited) gets a run for its version, keyed
 * `mnt:{id}:{version}`. Nothing is cancelled: a run for an older version, or for a cancelled
 * window, finds that when it next runs and stops.
 */
export async function steerMaintenance(
  type: "maintenance.scheduled" | "maintenance.cancelled",
  payload: unknown,
  { db, runs }: { db: Db; runs: LifecycleRuns },
) {
  if (type === "maintenance.cancelled") return;
  const { workspaceId, data } = maintenanceEvent.parse(payload);
  const window = await maintenanceRepository(db).findById(workspaceId, data.maintenanceId);
  if (!window || window.version !== data.version) return; // edited again: that edit starts its run
  await runs.start(
    { maintenanceId: window.id, workspaceId, version: window.version },
    `mnt:${window.id}:${window.version}`,
  );
}
