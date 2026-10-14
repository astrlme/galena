import { beat } from "../heartbeat.ts";
import { log } from "../log.ts";
import { noteFile, pageStore } from "../page-store.ts";
import { cronPayload, defineJob } from "../runner.ts";
import { readStates, runRollup } from "./rollup-uptime.ts";

/**
 * Hourly, at 35 past: keeps the page's "Updated" time under an hour old, so it never warns
 * "Status not confirmed", without reading Aurora unless the page may be behind detection.
 */
export const pageHeartbeatJob = defineJob({
  name: "page.heartbeat",
  payload: cronPayload,
  run: async () => {
    const plan = await beat({
      clock: { now: () => new Date() },
      store: pageStore,
      note: noteFile,
      readStates,
      rollup: runRollup,
    });
    log.info("page.heartbeat", plan);
    return plan;
  },
});
