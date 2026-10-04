import { readFileSync } from "node:fs";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  checkResult,
  detectionSettings,
  eventId,
  httpCheck,
  type MonitorsFile,
  type MonitorTransitioned,
  monitorId,
  type ProbeMessage,
  workspaceId,
} from "@galena/contracts";
import type { WorkflowEngine } from "@galena/core";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type EvaluatorDeps, processBatch, type SqsRecord } from "./evaluator.ts";
import { createStore, type Store } from "./store.ts";

// The replay scenarios again, now through SQS records, DynamoDB Local and a trigger.dev stand-in.
// Every batch is delivered twice at once (a visibility timeout running out mid-run) and every
// trigger fails on its first call, yet each expected transition must be triggered exactly once.
const FIXTURES = new URL("../../../test/fixtures/replay/", import.meta.url);
// Every replay scenario, maintenance included: its windows reach the evaluator in monitors.json.
const SCENARIOS = [
  "clean-outage",
  "single-region-blip",
  "probe-region-down",
  "flapping-endpoint",
  "latency-degradation",
  "outage-during-maintenance",
];
const REGIONS = ["us-east-1", "eu-west-1", "ap-southeast-1"];
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000a1");
const WORKSPACE = workspaceId.parse("01920000-0000-7000-8000-000000000001");

let container: StartedTestContainer | undefined;
let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;

beforeAll(async () => {
  container = await new GenericContainer("amazon/dynamodb-local:3.3.1")
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory"])
    .withExposedPorts(8000)
    .start();
  client = new DynamoDBClient({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
});

afterAll(async () => {
  client?.destroy();
  await container?.stop();
});

async function createTable(name: string) {
  await client.send(
    new CreateTableCommand({
      TableName: name,
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
}

type Line =
  | { type: "settings"; detection: object }
  | { type: "check"; at: string; region: string; status: "up" | "down"; latencyMs: number }
  | { type: "canary"; at: string; region: string; passed: boolean }
  | { type: "maintenance"; at: string; active: boolean };

/** The fixture's maintenance on/off lines as the windows `monitors.json` carries. */
function windows(lines: Line[]) {
  const found: { startsAt: string; endsAt: string }[] = [];
  let start: string | undefined;
  for (const line of lines) {
    if (line.type !== "maintenance") continue;
    if (line.active) start = line.at;
    else if (start) {
      found.push({ startsAt: start, endsAt: line.at });
      start = undefined;
    }
  }
  return found;
}

/** A scenario as the queue delivers it: one message per check or canary line, in order. */
function load(name: string) {
  const lines = readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
  const settings = lines.find((l) => l.type === "settings");
  const file: MonitorsFile = {
    version: 1,
    generatedAt: "2026-09-27T09:59:00.000Z",
    monitors: [
      {
        id: MONITOR,
        workspaceId: WORKSPACE,
        type: "http",
        http: httpCheck.parse({ url: "https://example.com/health" }),
        downStatus: "major_outage",
        detection: detectionSettings.parse(settings?.type === "settings" ? settings.detection : {}),
        maintenance: windows(lines),
      },
    ],
  };
  const records = lines.flatMap((line, i): SqsRecord[] => {
    let message: ProbeMessage;
    if (line.type === "check") {
      const down = line.status === "down";
      const result = checkResult.parse({
        monitorId: MONITOR,
        region: line.region,
        scheduledAt: line.at,
        checkedAt: line.at,
        status: line.status,
        httpStatus: down ? 503 : 200,
        latencyMs: line.latencyMs,
        phases: null,
        error: down ? { code: "http_status", message: "Expected a 2xx status, got 503." } : null,
        eventId: eventId.parse(v7()),
      });
      message = { kind: "check", result };
    } else if (line.type === "canary") {
      const { region, at, passed } = line;
      message = {
        kind: "canary",
        canary: { region, scheduledAt: at, passed, eventId: eventId.parse(v7()) },
      };
    } else {
      return [];
    }
    return [{ messageId: `m${i}`, body: JSON.stringify(message) }];
  });
  const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, FIXTURES), "utf8"));
  return { file, records, expected, checks: lines.filter((l) => l.type === "check").length };
}

/**
 * trigger.dev as seen from outside: the first call for each key fails, repeats are recorded.
 * It also notes any transition triggered before a state write held it, which a crash in
 * between would leave triggered but unrecorded. It asks the store itself: another copy may
 * trigger a transition it read back the moment the write landed, before the writer resumes.
 */
function flakyEngine(store: Store) {
  const calls: { key: string; payload: MonitorTransitioned }[] = [];
  const unpersisted: string[] = [];
  const failedOnce = new Set<string>();
  const engine: WorkflowEngine = {
    async trigger(_task, payload, { idempotencyKey }) {
      const { data } = payload as MonitorTransitioned;
      const stored = await store.getMonitor(data.monitorId);
      if ((stored?.detection.transitionSeq ?? 0) < data.transitionSeq) {
        unpersisted.push(idempotencyKey);
      }
      if (!failedOnce.has(idempotencyKey)) {
        failedOnce.add(idempotencyKey);
        throw new Error("trigger.dev is unreachable");
      }
      calls.push({ key: idempotencyKey, payload: payload as MonitorTransitioned });
    },
  };
  return { calls, unpersisted, engine };
}

/**
 * Batches of 10 in queue order, each delivered to two copies of the handler at once. Anything
 * either copy failed comes back, in order, until the batch goes through.
 */
async function deliver(records: SqsRecord[], deps: EvaluatorDeps) {
  for (let i = 0; i < records.length; i += 10) {
    let batch = records.slice(i, i + 10);
    for (let round = 0; batch.length > 0; round++) {
      if (round === 50) throw new Error(`Batch ${i / 10} made no progress.`);
      const copies = await Promise.all([processBatch(batch, deps), processBatch(batch, deps)]);
      const failed = new Set(
        copies.flatMap((c) => c.batchItemFailures.map((f) => f.itemIdentifier)),
      );
      batch = batch.filter((r) => failed.has(r.messageId));
    }
  }
}

test.each(SCENARIOS)("%s: every expected transition triggers exactly once", async (name) => {
  await createTable(name);
  const { file, records, expected, checks } = load(name);
  const store = createStore(doc, name);
  const { calls, unpersisted, engine } = flakyEngine(store);
  const conflicts: unknown[] = [];
  await deliver(records, {
    store,
    engine,
    loadConfig: async () => file,
    regions: REGIONS,
    now: (result) => new Date(Date.parse(result.scheduledAt) + 5_000),
    onError: (_, error) => conflicts.push(error),
  });

  // A repeated key must carry the same transition: trigger.dev then runs it once.
  const byKey = new Map<string, MonitorTransitioned>();
  for (const { key, payload } of calls) {
    const seen = byKey.get(key);
    if (seen) expect(payload).toEqual(seen);
    byKey.set(key, payload);
  }
  const triggered = [...byKey.values()].sort((a, b) => a.data.transitionSeq - b.data.transitionSeq);
  expect(triggered.map((t) => t.data.transitionSeq)).toEqual(triggered.map((_, i) => i + 1));
  expect(
    triggered.map(({ occurredAt, data }) => ({
      at: occurredAt,
      from: data.from,
      to: data.to,
      suppressed: data.suppressed,
    })),
  ).toEqual(expected);

  expect(unpersisted).toEqual([]);
  const state = await store.getMonitor(MONITOR);
  expect(state?.pending).toEqual([]);
  expect(state?.detection.transitionSeq).toBe(expected.length);
  // The races really happened: duplicate copies lost version checks or hit failed triggers.
  expect(conflicts.length).toBeGreaterThan(0);

  // One raw result per minute and region, however often it was delivered, expiring in 90 days.
  const { Items = [] } = await doc.send(
    new QueryCommand({
      TableName: name,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :r)",
      ExpressionAttributeValues: { ":pk": `MON#${MONITOR}`, ":r": "R#" },
    }),
  );
  expect(Items).toHaveLength(checks);
  const [first] = Items;
  expect(first?.ttl).toBe(Date.parse("2026-09-27T10:00:00.000Z") / 1000 + 90 * 86_400);
});

test("a failed message fails every message after it, so nothing overtakes it", async () => {
  await createTable("fifo-order");
  const { file, records } = load("clean-outage");
  const store = createStore(doc, "fifo-order");
  // A DynamoDB error on the third message only.
  const broken = (JSON.parse(records[2]?.body ?? "{}") as ProbeMessage & { kind: "check" }).result
    .eventId;
  let failures = 0;
  const outcome = await processBatch(records.slice(0, 10), {
    store: {
      ...store,
      async putResult(result) {
        if (result.eventId === broken) throw new Error("ProvisionedThroughputExceededException");
        await store.putResult(result);
      },
    },
    engine: { trigger: async () => undefined },
    loadConfig: async () => file,
    regions: REGIONS,
    now: (result) => new Date(Date.parse(result.scheduledAt) + 5_000),
    onError: () => failures++,
  });
  expect(failures).toBe(1);
  expect(outcome.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(
    records.slice(2, 10).map((r) => r.messageId),
  );
});
