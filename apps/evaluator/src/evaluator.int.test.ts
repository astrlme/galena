import { readFileSync } from "node:fs";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  checkResult,
  detectionSettings,
  eventId,
  heartbeatDetection,
  httpCheck,
  type MonitorsFile,
  type MonitorTransitioned,
  monitorId,
  PING_KEY,
  type ProbeMessage,
  workspaceId,
} from "@galena/contracts";
import type { WorkflowEngine } from "@galena/core";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type EvaluatorDeps, processBatch, type SqsRecord } from "./evaluator.ts";
import { createStore, type Store } from "./store.ts";
import { sweepHeartbeats } from "./sweep.ts";

// The replay scenarios again, now through SQS records, DynamoDB Local and a job queue stand-in.
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
  "missed-heartbeat",
  "flapping-heartbeat",
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
  | { type: "check"; at: string; region: string; status: "up" | "down"; latencyMs?: number }
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
        heartbeat: null,
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
        latencyMs: line.latencyMs ?? null,
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
  const checks = lines.filter((l) => l.type === "check");
  return { file, records, expected, checks: checks.length, firstAt: checks[0]?.at ?? "" };
}

/**
 * The job queue as seen from outside: the first call for each key fails, repeats are recorded.
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
        throw new Error("the job queue is unreachable");
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
  const { file, records, expected, checks, firstAt } = load(name);
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

  // A repeated key must carry the same transition: the queue then runs it once.
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
  expect(first?.ttl).toBe(Date.parse(firstAt) / 1000 + 90 * 86_400);
});

test("a result keeps the certificate its check saw, for the expiry scan to read", async () => {
  await createTable("certificates");
  const store = createStore(doc, "certificates");
  const certificate = {
    host: "api.example.com",
    validTo: "2026-11-18T12:00:00.000Z",
    issuer: "Let's Encrypt",
  };
  await store.putResult(
    checkResult.parse({
      monitorId: MONITOR,
      region: "eu-west-1",
      scheduledAt: "2026-11-08T09:00:00.000Z",
      checkedAt: "2026-11-08T09:00:01.000Z",
      status: "up",
      httpStatus: 200,
      latencyMs: 120,
      phases: null,
      error: null,
      certificate,
      eventId: eventId.parse(v7()),
    }),
  );
  const { Items = [] } = await doc.send(
    new QueryCommand({
      TableName: "certificates",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `MON#${MONITOR}` },
    }),
  );
  expect(Items[0]?.certificate).toEqual(certificate);
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

test("a missed window takes a heartbeat monitor down and the next check-in brings it up", async () => {
  await createTable("heartbeat");
  const store = createStore(doc, "heartbeat");
  const backups = monitorId.parse(v7());
  const silent = monitorId.parse(v7());
  const issuedAt = Date.parse("2026-11-07T08:00:00.000Z");
  const heartbeat = {
    periodMinutes: 60,
    graceMinutes: 5,
    tokenIssuedAt: new Date(issuedAt).toISOString(),
  };
  const file: MonitorsFile = {
    version: 1,
    generatedAt: "2026-11-07T08:00:00.000Z",
    monitors: [backups, silent].map((id) => ({
      id,
      workspaceId: WORKSPACE,
      type: "heartbeat",
      http: null,
      heartbeat,
      downStatus: "major_outage",
      detection: heartbeatDetection,
      maintenance: [],
    })),
  };
  // What the API writes for a check-in through the current URL.
  const checkIn = (iso: string) =>
    doc.send(
      new PutCommand({
        TableName: "heartbeat",
        Item: { pk: `MON#${backups}`, sk: PING_KEY, at: Date.parse(iso), issuedAt },
      }),
    );
  const triggered: { key: string; data: MonitorTransitioned["data"] }[] = [];
  const run = (scheduledAt: string) =>
    sweepHeartbeats(file, scheduledAt, {
      store,
      region: "eu-central-1",
      newEventId: () => eventId.parse(v7()),
      engine: {
        async trigger(_task, payload, { idempotencyKey }) {
          triggered.push({ key: idempotencyKey, data: (payload as MonitorTransitioned).data });
        },
      },
      now: (result) => new Date(Date.parse(result.scheduledAt) + 5_000),
      onError: (_, error) => {
        throw error;
      },
    });

  await checkIn("2026-11-07T10:00:12.000Z");
  await run("2026-11-07T10:01:00.000Z"); // on time
  await run("2026-11-07T11:05:00.000Z"); // still inside the grace
  // An hour and five minutes without a check-in, swept twice at once (overlapping runs) and
  // once more later: each monitor goes through once, and neither run fails.
  const overlapping = await Promise.all([
    run("2026-11-07T11:06:00.000Z"),
    run("2026-11-07T11:06:00.000Z"),
  ]);
  expect(overlapping.map((o) => o.failed)).toEqual([0, 0]);
  await run("2026-11-07T11:06:00.000Z");
  await checkIn("2026-11-07T11:09:40.000Z");
  await run("2026-11-07T11:10:00.000Z");

  expect(triggered).toEqual([
    { key: `mon:${backups}:1`, data: expect.objectContaining({ from: "unknown", to: "up" }) },
    { key: `mon:${backups}:2`, data: expect.objectContaining({ from: "up", to: "down" }) },
    { key: `mon:${backups}:3`, data: expect.objectContaining({ from: "down", to: "up" }) },
  ]);
  // The monitor that never checked in has no results and no state: it waits for its first.
  expect(await store.getMonitor(silent)).toBeUndefined();
  // Its minutes are on record like a probe's, the missed one saying why.
  const { Items = [] } = await doc.send(
    new QueryCommand({
      TableName: "heartbeat",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :r)",
      ExpressionAttributeValues: { ":pk": `MON#${backups}`, ":r": "R#" },
    }),
  );
  expect(Items.map((i) => [i.sk, i.status, i.error?.code ?? null])).toEqual([
    ["R#2026-11-07T10:01:00.000Z#eu-central-1", "up", null],
    ["R#2026-11-07T11:05:00.000Z#eu-central-1", "up", null],
    ["R#2026-11-07T11:06:00.000Z#eu-central-1", "down", "heartbeat_missed"],
    ["R#2026-11-07T11:10:00.000Z#eu-central-1", "up", null],
  ]);
});
