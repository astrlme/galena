// One-off: builds the hour and day rollups `rollup.telemetry` would have written, from the raw
// checks already stored (kept 90 days). Every item is put whole under its hour's or day's key,
// so a run that stops can simply be started again.
//
//   pnpm rollups:backfill                   DynamoDB Local and the local monitors.json
//   pnpm rollups:backfill --stage dev       a deployment: names from SSM, your AWS credentials
//   --days 30                               fewer days back (default 90)
//   --units 2                               capacity units a second it may use (default 2)

import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type ConsumedCapacity,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { monitorsFile } from "@galena/contracts";
import { dayKey } from "@galena/core";
import { monitorsFileFromS3 } from "@galena/integrations/config";
import {
  dynamoTelemetryStore,
  type MonitorToRoll,
  rollUpDay,
  rollUpHour,
  toRoll,
  writeSummary,
} from "./telemetry-rollup.ts";

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    region: { type: "string", default: "eu-central-1" },
    days: { type: "string", default: "90" },
    units: { type: "string", default: "2" },
  },
});
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  throw new Error("--days takes a whole number from 1 to 90: raw checks are kept 90 days.");
}
const units = Number(values.units);
if (!(units > 0)) throw new Error("--units takes a number above 0, such as 2.");
const region = values.region;

async function parameter(name: string): Promise<string> {
  const ssm = new SSMClient({ region });
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name }));
  if (!Parameter?.Value) throw new Error(`SSM has no ${name}; check --stage and --region.`);
  return Parameter.Value;
}

/**
 * The evaluator writes to the same provisioned table, so the backfill keeps to `--units` a
 * second: after each request it waits for the capacity that request used.
 */
function paced(client: DynamoDBClient): DynamoDBDocumentClient {
  client.middlewareStack.add(
    (next) => async (args) => {
      Object.assign(args.input, { ReturnConsumedCapacity: "TOTAL" });
      const result = await next(args);
      const used = [
        (result.output as { ConsumedCapacity?: ConsumedCapacity | ConsumedCapacity[] })
          .ConsumedCapacity,
      ]
        .flat()
        .reduce((sum, c) => sum + (c?.CapacityUnits ?? 0), 0);
      await sleep((used / units) * 1000);
      return result;
    },
    { step: "initialize", name: "pace" },
  );
  return DynamoDBDocumentClient.from(client);
}

async function target(): Promise<{
  table: string;
  doc: DynamoDBDocumentClient;
  monitors: MonitorToRoll[];
}> {
  // Adaptive retries slow down further if the table throttles anyway.
  const retries = { maxAttempts: 10, retryMode: "adaptive" as const };
  if (values.stage) {
    const table = await parameter(`/galena/${values.stage}/telemetry-table`);
    const bucket = await parameter(`/galena/${values.stage}/config-bucket`);
    const file = await monitorsFileFromS3({ region, bucket, key: "monitors.json" })();
    const doc = paced(new DynamoDBClient({ region, ...retries }));
    return { table, doc, monitors: toRoll(file) };
  }
  const path = new URL("../.local/config/monitors.json", import.meta.url);
  const file = monitorsFile.parse(JSON.parse(await readFile(path, "utf8")));
  const doc = paced(
    new DynamoDBClient({
      endpoint: "http://localhost:8000",
      region,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
      ...retries,
    }),
  );
  return { table: "telemetry", doc, monitors: toRoll(file) };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const { table, doc, monitors } = await target();
const store = dynamoTelemetryStore(doc, table);
const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
console.log(`Rolling up ${days} days for ${monitors.length} monitors in ${table}.`);
let left = days;
try {
  // Oldest first, so a run that stops can go on with `--days` set to the days it had left.
  for (let d = days; d >= 1; d--, left--) {
    const day = dayKey(today - d * DAY);
    for (const monitor of monitors) await rollUpDay(store, monitor, day, now);
    console.log(`${day} done`);
  }
  // Today's whole hours, so the day and week charts are complete until the next run at :05.
  for (let start = today; start + HOUR <= now; start += HOUR) {
    for (const monitor of monitors) await rollUpHour(store, monitor, start, now);
  }
  // Each monitor's summary to the last whole hour, as the next run would write it.
  const last = Math.floor(now / HOUR) * HOUR - HOUR;
  for (const monitor of monitors) {
    await writeSummary(store, monitor, last, await rollUpHour(store, monitor, last, now));
  }
} catch (error) {
  if (error instanceof ResourceNotFoundException) {
    console.error(
      `There is no ${table} table yet. Locally, run \`pnpm dev:local\` once so the hot path makes it.`,
    );
  } else {
    console.error(error);
    console.error(
      `Stopped with ${left} days left; to go on, run it again with --days ${Math.max(left, 1)}.`,
    );
  }
  process.exit(1);
}
console.log("Backfill complete.");
