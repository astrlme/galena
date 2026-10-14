import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { db } from "../db.ts";
import { triggerPublish } from "../engine.ts";
import { env } from "../env.ts";
import { errorFields, log } from "../log.ts";
import { rollUpUptime } from "../rollup.ts";
import { cronPayload, defineJob } from "../runner.ts";
import { catchUpStates, dynamoStates } from "../states.ts";

// DynamoDB Local takes any credentials; in AWS stages, those of the worker access user.
const endpoint =
  env.GLN_DYNAMODB_ENDPOINT ?? (env.GLN_DB_CLUSTER_ARN ? undefined : "http://localhost:8000");
const dynamo = new DynamoDBClient(
  endpoint
    ? {
        endpoint,
        region: env.GLN_HOME_REGION,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : { region: env.GLN_HOME_REGION },
);
/** Detection's monitor states, as the evaluator wrote them; read only. */
export const readStates = dynamoStates(
  DynamoDBDocumentClient.from(dynamo),
  env.GLN_TELEMETRY_TABLE,
);

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
