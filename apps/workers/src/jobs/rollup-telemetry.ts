import { fixedClock } from "@galena/core";
import { telemetryDoc } from "../dynamo.ts";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { monitorsToRoll } from "../monitors-list.ts";
import { cronPayload, defineJob } from "../runner.ts";
import { dynamoTelemetryStore, rollUpTelemetry } from "../telemetry-rollup.ts";

const store = dynamoTelemetryStore(telemetryDoc, env.GLN_TELEMETRY_TABLE);

/**
 * Hourly, at five past: rolls the last hour of checks up for the charts, and after midnight the
 * day that ended. Reads `monitors.json` and DynamoDB only, so Aurora stays paused.
 */
export const rollupTelemetryJob = defineJob({
  name: "rollup.telemetry",
  payload: cronPayload,
  // The schedule's own time, not the clock's: a late or retried run still rolls up its hour.
  run: async ({ timestamp }) => {
    const result = await rollUpTelemetry({
      clock: fixedClock(timestamp),
      store,
      monitors: monitorsToRoll,
    });
    log.info("rollup.telemetry", result);
    return result;
  },
});
