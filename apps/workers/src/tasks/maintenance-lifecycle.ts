import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { lifecyclePayload, runMaintenance } from "../maintenance.ts";
import { globalKey } from "./keys.ts";

const maintenance = queue({ name: "maintenance", concurrencyLimit: 5 });

/** One version of one window, run by outbox.dispatch and again at startsAt and endsAt. */
export const maintenanceLifecycle = task({
  id: "maintenance.lifecycle",
  queue: maintenance,
  run: async (payload: unknown) => {
    const window = lifecyclePayload.parse(payload);
    const outcome = await runMaintenance(window, {
      db,
      clock: { now: () => new Date() },
      wakeAt: async (next, idempotencyKey) => {
        await tasks.trigger("maintenance.lifecycle", next, {
          idempotencyKey: await globalKey(idempotencyKey),
          delay: new Date(next.at),
        });
      },
      dispatch: async (outboxId) => {
        await tasks.trigger(
          "outbox.dispatch",
          { outboxId },
          { idempotencyKey: await globalKey(`outbox:${outboxId}`) },
        );
      },
    });
    logger.info("maintenance.lifecycle", { ...window, outcome });
    return { outcome };
  },
});
