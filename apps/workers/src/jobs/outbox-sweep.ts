import { db } from "../db.ts";
import { engine } from "../engine.ts";
import { log } from "../log.ts";
import { sweepOutbox } from "../outbox.ts";
import { cronPayload, defineJob } from "../runner.ts";

/**
 * Every six hours, at the minute `rollup.uptime` reads Aurora. Each run gets its own key per row,
 * so a row whose earlier runs failed is tried again.
 */
export const outboxSweepJob = defineJob({
  name: "outbox.sweep",
  payload: cronPayload,
  run: async ({ timestamp }) => {
    const hour = timestamp.slice(0, 13);
    const result = await sweepOutbox({
      db,
      clock: { now: () => new Date() },
      redispatch: (ids) =>
        engine().triggerAll(
          "outbox.dispatch",
          ids.map((outboxId) => ({
            payload: { outboxId },
            options: { idempotencyKey: `outbox:${outboxId}:sweep:${hour}` },
          })),
        ),
    });
    log.info("outbox.sweep", result);
    return result;
  },
});
