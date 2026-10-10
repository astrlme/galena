import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { logger, schedules } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { rollUpUptime } from "../rollup.ts";
import { catchUpStates, dynamoStates } from "../states.ts";
import { triggerPublish } from "./page-publish.ts";

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
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error("monitor states not caught up", { reason });
    return undefined;
  });
  const result = await rollUpUptime({ db, clock, publish: triggerPublish });
  logger.info("rollup.uptime", { ...(result ?? { outcome: "no_page" }), ...states });
  return result;
}

/**
 * Every six hours, at five past (the only times anything scheduled reads Aurora). The hourly
 * `page.heartbeat` runs it sooner when the page may be behind detection.
 */
export const rollupUptimeTask = schedules.task({
  id: "rollup.uptime",
  // Zero window: trigger.dev spreads new schedules across the hour by default, and both tasks
  // must share the minute so Aurora wakes once.
  cron: { pattern: "5 */6 * * *", window: "0m" },
  run: runRollup,
});
