import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { MonitorId } from "@galena/contracts";
import { fixedClock, quantileOf, rollUp } from "@galena/core";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dynamoTelemetryStore, rollUpDay, rollUpTelemetry } from "./telemetry-rollup.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const MONITOR = "01920000-0000-7000-8000-0000000000c1" as MonitorId;
const PK = `MON#${MONITOR}`;
const HOUR = Date.parse("2026-11-01T23:00:00.000Z");

let container: StartedTestContainer | undefined;
let doc: DynamoDBDocumentClient;

async function put(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    await doc.send(
      new BatchWriteCommand({
        RequestItems: {
          telemetry: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
  }
}

async function items(prefix?: string, pk = PK) {
  const { Items = [] } = await doc.send(
    new QueryCommand({
      TableName: "telemetry",
      KeyConditionExpression: prefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
      ExpressionAttributeValues: prefix ? { ":pk": pk, ":p": prefix } : { ":pk": pk },
    }),
  );
  return new Map(Items.map((item) => [String(item.sk), item]));
}

beforeAll(async () => {
  container = await new GenericContainer("amazon/dynamodb-local:3.3.1")
    .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory"])
    .withExposedPorts(8000)
    .start();
  const client = new DynamoDBClient({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
    region: "eu-central-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  doc = DynamoDBDocumentClient.from(client);
  await client.send(
    new CreateTableCommand({
      TableName: "telemetry",
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
  // The day's last hour, as the evaluator writes it: Ireland fails minutes 0-4 and Paris 0-2,
  // so a quorum of two fails for three minutes. Every answer takes 100 ms plus the minute.
  const raw: Record<string, unknown>[] = [];
  for (let n = 0; n < 60; n++) {
    for (const region of REGIONS) {
      const down = (region === "eu-west-1" && n < 5) || (region === "eu-west-3" && n < 3);
      raw.push({
        pk: PK,
        sk: `R#${new Date(HOUR + n * 60_000).toISOString()}#${region}`,
        status: down ? "down" : "up",
        latencyMs: down ? null : 100 + n,
        phases: down ? null : { dns: 4, connect: 10, tls: 20, ttfb: 90 + n, total: 100 + n },
      });
    }
  }
  await put(raw);
  // An hour already rolled up earlier that day, which the day must take in: Ireland answered
  // every minute of 22:00.
  const earlier = rollUp(
    Array.from({ length: 60 }, (_, n) => ({
      region: "eu-west-1",
      scheduledAt: new Date(HOUR - 3_600_000 + n * 60_000).toISOString(),
      status: "up" as const,
      latencyMs: 200,
      phases: null,
    })),
    2,
  );
  await put([
    {
      pk: PK,
      sk: "H#2026-11-01T22#eu-west-1",
      ...(earlier.regions.get("eu-west-1") ?? expect.fail("no rollup")),
    },
    { pk: PK, sk: "UH#2026-11-01T22", ...earlier.minutes },
  ]);
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

test("the run after midnight rolls up the last hour, then the day from its hours", async () => {
  const store = dynamoTelemetryStore(doc, "telemetry");
  const run = () =>
    rollUpTelemetry({
      clock: fixedClock("2026-11-02T00:05:00.000Z"),
      store,
      monitors: async () => [{ id: MONITOR, quorum: 2 }],
    });
  expect(await run()).toEqual({ hour: "2026-11-01T23", monitors: 1, day: "2026-11-01" });

  const hours = await items("H#");
  expect(hours.size).toBe(4); // three regions of 23:00, and Ireland's 22:00
  const ireland = hours.get("H#2026-11-01T23#eu-west-1");
  expect(ireland).toMatchObject({ checks: 60, up: 55, down: 5, maxMs: 159 });
  // 55 answers from 105 to 159 ms: p95 is about 157, within a bucket's 12%.
  const p95 = quantileOf((ireland?.total as number[]) ?? [], 0.95) as number;
  expect(p95).toBeGreaterThan(157 * 0.88);
  expect(p95).toBeLessThan(157 * 1.12);
  expect(Number(ireland?.ttl)).toBe(HOUR / 1000 + 30 * 24 * 60 * 60);
  expect((await items("UH#")).get("UH#2026-11-01T23")).toMatchObject({ minutes: 60, down: 3 });

  const days = await items("D#");
  expect([...days.keys()].sort()).toEqual([
    "D#2026-11-01#eu-north-1",
    "D#2026-11-01#eu-west-1",
    "D#2026-11-01#eu-west-3",
  ]);
  expect(days.get("D#2026-11-01#eu-west-1")).toMatchObject({ checks: 120, down: 5, maxMs: 200 });
  expect(days.get("D#2026-11-01#eu-west-3")).toMatchObject({ checks: 60, down: 3 });
  expect((await items("UD#")).get("UD#2026-11-01")).toMatchObject({ minutes: 120, down: 3 });

  // A repeated run writes the same items.
  const before = await items();
  await run();
  expect(await items()).toEqual(before);
});

test("a run during the day rolls up its hour and leaves the day alone", async () => {
  const result = await rollUpTelemetry({
    clock: fixedClock("2026-11-01T14:05:00.000Z"),
    store: dynamoTelemetryStore(doc, "telemetry"),
    monitors: async () => [{ id: MONITOR, quorum: 2 }],
  });
  // No checks in 13:00-13:59, so nothing new is written.
  expect(result).toEqual({ hour: "2026-11-01T13", monitors: 1, day: null });
  expect((await items("H#2026-11-01T13")).size).toBe(0);
});

test("the backfill writes a day older than 30 days, but not its hours, which would be expired", async () => {
  const old = "01920000-0000-7000-8000-0000000000c2" as MonitorId;
  const pk = `MON#${old}`;
  await put(
    REGIONS.map((region) => ({
      pk,
      sk: `R#2026-09-01T12:00:00.000Z#${region}`,
      status: "up",
      latencyMs: 80,
      phases: null,
    })),
  );
  const store = dynamoTelemetryStore(doc, "telemetry");
  await rollUpDay(store, { id: old, quorum: 2 }, "2026-09-01", Date.parse("2026-11-02T00:00:00Z"));
  expect((await items("H#", pk)).size).toBe(0);
  expect((await items("UH#", pk)).size).toBe(0);
  expect((await items("D#", pk)).size).toBe(3);
  expect((await items("UD#", pk)).get("UD#2026-09-01")).toMatchObject({ minutes: 1, down: 0 });
});
