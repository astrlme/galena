import { logger, schedules } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { rollUpUptime } from "../rollup.ts";
import { triggerPublish } from "./page-publish.ts";

/**
 * Hourly, at minute 5 (the one minute an hour anything scheduled reads Aurora). Saving a day's
 * rollup replaces it, so a retried run writes the same rows.
 */
export const rollupUptimeTask = schedules.task({
  id: "rollup.uptime",
  cron: "5 * * * *",
  run: async () => {
    const result = await rollUpUptime({
      db,
      clock: { now: () => new Date() },
      publish: triggerPublish,
    });
    logger.info("rollup.uptime", { ...(result ?? { outcome: "no_page" }) });
    return result;
  },
});
