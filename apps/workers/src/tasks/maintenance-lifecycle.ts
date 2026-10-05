import { logger, queue, task, tasks, wait } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { lifecyclePayload, runMaintenance } from "../maintenance.ts";
import { globalKey } from "./keys.ts";

const maintenance = queue({ name: "maintenance", concurrencyLimit: 5 });

/** One version of one window, from scheduled to completed; started by outbox.dispatch. */
export const maintenanceLifecycle = task({
  id: "maintenance.lifecycle",
  queue: maintenance,
  run: async (payload: unknown) => {
    const window = lifecyclePayload.parse(payload);
    const outcome = await runMaintenance(window, {
      db,
      clock: { now: () => new Date() },
      waitUntil: (date) => wait.until({ date }),
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
