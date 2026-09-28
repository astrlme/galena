import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { monitorId } from "@galena/contracts";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dynamoTelemetry, RECENT_MINUTES } from "./telemetry.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000b1");
const SILENT = monitorId.parse("01920000-0000-7000-8000-0000000000b2");
const START = Date.parse("2026-09-28T16:00:00.000Z");
const minute = (n: number) => new Date(START + n * 60_000).toISOString();

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

  // 70 minutes, the way the evaluator writes them; eu-north-1 misses every tenth minute.
  const items: Record<string, unknown>[] = [
    {
      pk: `MON#${MONITOR}`,
      sk: "STATE",
      detection: { state: "up", enteredAt: START + 5 * 60_000, transitionSeq: 1 },
      version: 70,
    },
  ];
  for (let n = 0; n < 70; n++) {
    for (const region of REGIONS) {
      if (region === "eu-north-1" && n % 10 === 0) continue;
      const down = n === 69 && region === "eu-west-1";
      items.push({
        pk: `MON#${MONITOR}`,
        sk: `R#${minute(n)}#${region}`,
        status: down ? "down" : "up",
        latencyMs: down ? null : 100 + n,
        error: down ? { code: "timeout", message: "No complete response within 10000 ms." } : null,
        ttl: 0,
      });
    }
  }
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await doc.send(new BatchWriteCommand({ RequestItems: { telemetry: batch } }));
  }
});

afterAll(async () => {
  client?.destroy();
  await container?.stop();
});

test("reads the state and the newest 60 minutes of results, newest first", async () => {
  const readings = await dynamoTelemetry(doc, "telemetry", REGIONS).read([MONITOR, SILENT]);

  const reading = readings.get(MONITOR);
  expect(reading).toMatchObject({ state: "up", enteredAt: START + 5 * 60_000 });
  const results = reading?.results ?? [];
  const minutes = [...new Set(results.map((r) => r.scheduledAt))];
  expect(minutes).toHaveLength(RECENT_MINUTES);
  expect(minutes[0]).toBe(minute(69));
  expect(minutes.at(-1)).toBe(minute(10));
  expect(results.find((r) => r.region === "eu-west-1")).toEqual({
    region: "eu-west-1",
    scheduledAt: minute(69),
    status: "down",
    latencyMs: null,
  });
  expect(results.find((r) => r.region === "eu-west-3")).toEqual({
    region: "eu-west-3",
    scheduledAt: minute(69),
    status: "up",
    latencyMs: 169,
  });

  // No state item and no results: detection hasn't seen it yet.
  expect(readings.get(SILENT)).toEqual({ state: "unknown", enteredAt: 0, results: [] });
});

test("a table that doesn't exist yet reads as no data", async () => {
  const readings = await dynamoTelemetry(doc, "not-created", REGIONS).read([MONITOR]);
  expect(readings.size).toBe(0);
});
