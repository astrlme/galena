import { heartbeat } from "@galena/integrations/net";
import { heartbeatUrl } from "../env.ts";
import { beat } from "../heartbeat.ts";
import { log } from "../log.ts";
import { noteFile, pageStore } from "../page-store.ts";
import { cronPayload, defineJob } from "../runner.ts";
import { readStates, runRollup } from "./rollup-uptime.ts";

// Job modules load after the host has read the ping URL.
const ping = heartbeat({
  url: heartbeatUrl(),
  onFailure: (reason) => log.error("heartbeat ping failed", reason),
});

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
    // The run got this far, so the schedules, the queue and the jobs function all work.
    await ping();
    return plan;
  },
});
