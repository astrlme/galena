// Local development: the hot path in one process. Each tick stands for one scheduled minute:
// three simulated probe regions check every enabled monitor, an in-memory FIFO carries their
// messages, and the evaluator writes state and results to DynamoDB Local, where the API reads
// them. Monitors come straight from the local database, so trigger.dev isn't needed.
import { setTimeout as sleep } from "node:timers/promises";
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { awsRegion, eventId } from "@galena/contracts";
import { buildMonitorsFile, type WorkflowEngine } from "@galena/core";
import { createDb, listEnabledMonitors, maintenanceRepository } from "@galena/db";
import { checkHttp } from "@galena/integrations/net";
import { v7 } from "uuid";
import { z } from "zod";
import { targetGuard } from "../apps/api/src/targets.ts";
import { processBatch, type SqsRecord } from "../apps/evaluator/src/evaluator.ts";
import { createStore } from "../apps/evaluator/src/store.ts";
import { runProbe } from "../apps/probe/src/probe.ts";

const MINUTE = 60_000;

const env = z
  .object({
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    GLN_DYNAMODB_ENDPOINT: z.url().default("http://localhost:8000"),
    GLN_TELEMETRY_TABLE: z.string().min(1).default("telemetry"),
    GLN_PROBE_REGIONS: z
      .string()
      .default("eu-west-1,eu-west-3,eu-north-1")
      .transform((list) => list.split(",").map((r) => r.trim()))
      .pipe(z.array(awsRegion).min(1)),
    GLN_CANARY_URL: z.url().default("https://checkip.amazonaws.com/"),
    /** Real seconds per simulated minute. Below 60 (tests), time runs ahead of the clock. */
    GLN_TICK_SECONDS: z.coerce.number().min(1).max(60).default(60),
    GLN_ALLOW_LOOPBACK: z.stringbool().default(false),
  })
  .parse(process.env);

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(env.GLN_DATABASE_URL)) {
  throw new Error("dev:hot-path only runs against the local docker-compose database.");
}

const { db } = createDb({ kind: "postgres", url: env.GLN_DATABASE_URL });
const dynamo = new DynamoDBClient({
  endpoint: env.GLN_DYNAMODB_ENDPOINT,
  region: "eu-central-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
try {
  await dynamo.send(
    new CreateTableCommand({
      TableName: env.GLN_TELEMETRY_TABLE,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
} catch (error) {
  if (!(error instanceof ResourceInUseException)) throw error;
}
const store = createStore(
  DynamoDBDocumentClient.from(dynamo, { marshallOptions: { removeUndefinedValues: true } }),
  env.GLN_TELEMETRY_TABLE,
);
const guard = targetGuard("local", env.GLN_ALLOW_LOOPBACK);
// Known limit: transitions are logged here, not triggered in trigger.dev.
const engine: WorkflowEngine = { trigger: async () => {} };

// Continue after the newest minute already stored: the evaluator skips a minute it has seen,
// so a restart after fast ticks must not go back to the clock.
const health = await store.getRegionHealth(env.GLN_PROBE_REGIONS);
let minute = Math.max(
  Math.floor(Date.now() / MINUTE) * MINUTE,
  ...[...health.values()].map((h) => h.lastScheduledAt + MINUTE),
);
const queue: SqsRecord[] = [];
let sequence = 0;

async function tick() {
  const scheduledAt = new Date(minute).toISOString();
  const [monitors, windows] = await Promise.all([
    listEnabledMonitors(db),
    maintenanceRepository(db).listUnfinished(),
  ]);
  const file = buildMonitorsFile(monitors, { now: () => new Date() }, windows);
  await Promise.all(
    env.GLN_PROBE_REGIONS.map((region) =>
      runProbe(file, scheduledAt, {
        region,
        canaryUrl: env.GLN_CANARY_URL,
        check: (check) => checkHttp(check, guard),
        send: async (batch) => {
          for (const message of batch) {
            queue.push({ messageId: String(sequence++), body: JSON.stringify(message) });
          }
        },
        newEventId: () => eventId.parse(v7()),
        now: () => new Date(),
      }),
    ),
  );

  // Batches of 10 as SQS delivers them; a failed batch waits for the next tick.
  while (queue.length > 0) {
    const batch = queue.slice(0, 10);
    const outcome = await processBatch(batch, {
      store,
      loadConfig: async () => file,
      engine,
      regions: env.GLN_PROBE_REGIONS,
      now: () => new Date(minute + 30_000),
      onError: (record, error) => console.error(`message ${record.messageId} failed`, error),
    });
    for (const { data } of outcome.transitions) {
      console.log(`${scheduledAt} monitor ${data.monitorId}: ${data.from} → ${data.to}`);
    }
    const failed = new Set(outcome.batchItemFailures.map((f) => f.itemIdentifier));
    queue.splice(0, batch.length, ...batch.filter((r) => failed.has(r.messageId)));
    if (failed.size > 0) break;
  }
  minute += MINUTE;
}

console.log(
  `hot path running: ${env.GLN_PROBE_REGIONS.join(", ")}, one minute every ${env.GLN_TICK_SECONDS} s`,
);
for (;;) {
  const started = Date.now();
  await tick().catch((error: unknown) => console.error("tick failed", error));
  await sleep(Math.max(0, env.GLN_TICK_SECONDS * 1000 - (Date.now() - started)));
}
