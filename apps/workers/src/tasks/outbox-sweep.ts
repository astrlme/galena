import { logger, schedules, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { sweepOutbox } from "../outbox.ts";
import { globalKey } from "./keys.ts";

/**
 * Hourly, at the minute the other hourly tasks read Aurora. Each hour gets its own key per row,
 * so a row whose earlier runs failed is tried again.
 */
export const outboxSweep = schedules.task({
  id: "outbox.sweep",
  cron: "5 * * * *",
  run: async ({ timestamp }) => {
    const hour = timestamp.toISOString().slice(0, 13);
    const result = await sweepOutbox({
      db,
      clock: { now: () => new Date() },
      redispatch: async (ids) => {
        await tasks.batchTrigger(
          "outbox.dispatch",
          await Promise.all(
            ids.map(async (outboxId) => ({
              payload: { outboxId },
              options: { idempotencyKey: await globalKey(`outbox:${outboxId}:sweep:${hour}`) },
            })),
          ),
        );
      },
    });
    logger.info("outbox.sweep", result);
    return result;
  },
});
