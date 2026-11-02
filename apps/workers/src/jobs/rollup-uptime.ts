import { db } from "../db.ts";
import { telemetryDoc } from "../dynamo.ts";
import { triggerPublish } from "../engine.ts";
import { env } from "../env.ts";
import { errorFields, log } from "../log.ts";
import { rollUpUptime } from "../rollup.ts";
import { cronPayload, defineJob } from "../runner.ts";
import { catchUpStates, dynamoStates } from "../states.ts";

/** Detection's monitor states, as the evaluator wrote them; read only. */
export const readStates = dynamoStates(telemetryDoc, env.GLN_TELEMETRY_TABLE);

/**
 * Catches monitor states that fell behind detection up, so the rollup counts them, then rolls
 * up uptime and publishes. Saving a day's rollup replaces it, so a retried run writes the same
 * rows. `page.heartbeat` runs it too, when the page may be behind detection.
 */
export async function runRollup() {
  const clock = { now: () => new Date() };
  // A failed read must not hold up the rollup; the next run tries again.
  const states = await catchUpStates({ db, clock, readStates }).catch((error: unknown) => {
    log.error("monitor states not caught up", errorFields(error));
    return undefined;
  });
  const result = await rollUpUptime({ db, clock, publish: triggerPublish });
  log.info("rollup.uptime", { ...(result ?? { outcome: "no_page" }), ...states });
  return result;
}

/**
 * Every six hours, at five past (the only times anything scheduled reads Aurora). The hourly
 * `page.heartbeat` runs it sooner when the page may be behind detection.
 */
export const rollupUptimeJob = defineJob({
  name: "rollup.uptime",
  payload: cronPayload,
  run: () => runRollup(),
});
