import { db } from "../db.ts";
import { engine, triggerDispatch } from "../engine.ts";
import { log } from "../log.ts";
import { lifecyclePayload, runMaintenance } from "../maintenance.ts";
import { defineJob } from "../runner.ts";

/** One version of one window, run by outbox.dispatch and again at startsAt and endsAt. */
export const maintenanceLifecycleJob = defineJob({
  name: "maintenance.lifecycle",
  payload: lifecyclePayload,
  run: async (window) => {
    const outcome = await runMaintenance(window, {
      db,
      clock: { now: () => new Date() },
      wakeAt: (next, idempotencyKey) =>
        engine().trigger("maintenance.lifecycle", next, {
          idempotencyKey,
          at: new Date(next.at),
        }),
      dispatch: triggerDispatch,
    });
    log.info("maintenance.lifecycle", { ...window, outcome });
    return { outcome };
  },
});
