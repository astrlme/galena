import { logger, schedules } from "@trigger.dev/sdk";
import { beat } from "../heartbeat.ts";
import { publisher } from "./page-publish.ts";
import { noteFile, pageStore } from "./page-store.ts";
import { readStates, runRollup } from "./rollup-uptime.ts";

/**
 * Hourly, at 35 past: keeps the page's "Updated" time under an hour old, so it never warns
 * "Status not confirmed", without reading Aurora unless the page may be behind detection.
 */
export const pageHeartbeat = schedules.task({
  id: "page.heartbeat",
  queue: publisher,
  // Zero window: trigger.dev spreads new schedules across the hour by default.
  cron: { pattern: "35 * * * *", window: "0m" },
  run: async () => {
    const plan = await beat({
      clock: { now: () => new Date() },
      store: pageStore,
      note: noteFile,
      readStates,
      rollup: runRollup,
    });
    logger.info("page.heartbeat", plan);
    return plan;
  },
});
