import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { monitorId } from "@galena/contracts";
import { rollUp, seriesWindow } from "@galena/core";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dynamoTelemetry, RECENT_MINUTES } from "./telemetry.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000b1");
const SILENT = monitorId.parse("01920000-0000-7000-8000-0000000000b2");
const START = Date.parse("2026-09-28T16:00:00.000Z");
const minute = (n: number) => new Date(START + n * 60_000).toISOString();
// The summary the hourly rollup would have written.
const SUMMARY = {
  through: "2026-09-28T16",
  hourlyMedianMs: [...Array.from({ length: 23 }, () => null), 120],
  p95Ms: 180,
  minutes: 1440,
  minutesDown: 2,
};

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
    { pk: `MON#${MONITOR}`, sk: "SUMMARY", ...SUMMARY },
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

test("reads the state, the summary and the newest 60 minutes of results, newest first", async () => {
  const readings = await dynamoTelemetry(doc, "telemetry", REGIONS).read(
    [MONITOR, SILENT],
    RECENT_MINUTES,
  );

  const reading = readings.get(MONITOR);
  expect(reading).toMatchObject({ state: "up", enteredAt: START + 5 * 60_000, summary: SUMMARY });
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
  expect(readings.get(SILENT)).toEqual({
    state: "unknown",
    enteredAt: 0,
    results: [],
    summary: null,
    ping: null,
  });
});

test("a check-in through an older URL never overwrites a newer one's, and the newest reads back", async () => {
  const telemetry = dynamoTelemetry(doc, "telemetry", REGIONS);
  const first = new Date("2026-11-07T08:00:00.000Z");
  const second = new Date("2026-11-07T09:00:00.000Z");
  expect(await telemetry.checkIn(SILENT, first, new Date("2026-11-07T10:00:00.000Z"))).toBe(true);
  expect(await telemetry.checkIn(SILENT, second, new Date("2026-11-07T10:05:00.000Z"))).toBe(true);
  // The replaced URL is refused, and its check-in leaves the newer one as it was.
  expect(await telemetry.checkIn(SILENT, first, new Date("2026-11-07T10:10:00.000Z"))).toBe(false);

  const readings = await telemetry.read([SILENT], 1, [SILENT]);
  expect(readings.get(SILENT)?.ping).toEqual({
    at: Date.parse("2026-11-07T10:05:00.000Z"),
    issuedAt: second.getTime(),
  });
  // Asked without it, a monitor's check-in isn't read.
  expect((await telemetry.read([SILENT], 1)).get(SILENT)?.ping).toBeNull();
  // Each recorded check-in is listed, newest first; the refused one is not.
  expect(await telemetry.checkIns(SILENT, 20)).toEqual([
    "2026-11-07T10:05:00.000Z",
    "2026-11-07T10:00:00.000Z",
  ]);
  expect(await telemetry.checkIns(SILENT, 1)).toEqual(["2026-11-07T10:05:00.000Z"]);
});

test("a reading asked for fewer minutes reads only the newest ones", async () => {
  const readings = await dynamoTelemetry(doc, "telemetry", REGIONS).read([MONITOR], 2);
  const results = readings.get(MONITOR)?.results ?? [];
  expect(new Set(results.map((r) => r.scheduledAt))).toEqual(new Set([minute(69), minute(68)]));
  expect(results).toHaveLength(6);
});

test("a table that doesn't exist yet reads as no data", async () => {
  const readings = await dynamoTelemetry(doc, "not-created", REGIONS).read(
    [MONITOR],
    RECENT_MINUTES,
  );
  expect(readings.size).toBe(0);
  expect(await dynamoTelemetry(doc, "not-created", REGIONS).checks(MONITOR, minute(10))).toEqual(
    [],
  );
});

test("a monitor's last hour of checks carries each failure's error", async () => {
  const telemetry = dynamoTelemetry(doc, "telemetry", REGIONS);
  const results = await telemetry.checks(MONITOR, minute(10));
  expect(new Set(results.map((r) => r.scheduledAt)).size).toBe(RECENT_MINUTES);
  expect(results[0]?.scheduledAt).toBe(minute(69));
  expect(results.find((r) => r.region === "eu-west-1")).toEqual({
    region: "eu-west-1",
    scheduledAt: minute(69),
    status: "down",
    latencyMs: null,
    error: { code: "timeout", message: "No complete response within 10000 ms." },
  });
  expect(results.find((r) => r.region === "eu-west-3")?.error).toBeNull();
  // Seen at 17:10 with nothing since 17:05: only those five minutes are its last hour.
  const late = await telemetry.checks(MONITOR, minute(65));
  expect(new Set(late.map((r) => r.scheduledAt)).size).toBe(5);
});

const CHARTED = monitorId.parse("01920000-0000-7000-8000-0000000000b3");
const DAY = 24 * 60 * 60_000;

/** Puts items 25 at a time. */
async function put(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await doc.send(new BatchWriteCommand({ RequestItems: { telemetry: batch } }));
  }
}

test("a 90-day chart reads one item per region per day, and a month adds its days and today's hours", async () => {
  // 400 days of daily rollups in three regions, the way the rollup writes them: one answer a day
  // of 100 ms, and Ireland down for the day's other check.
  const day =
    rollUp(
      [
        { region: "eu-west-1", scheduledAt: "t1", status: "up", latencyMs: 100, phases: null },
        { region: "eu-west-1", scheduledAt: "t2", status: "down", latencyMs: null, phases: null },
      ],
      2,
    ).regions.get("eu-west-1") ?? expect.fail("no rollup");
  const now = new Date("2026-11-02T13:20:00.000Z");
  const items: Record<string, unknown>[] = [];
  for (let n = 1; n <= 400; n++) {
    const key = new Date(now.getTime() - n * DAY).toISOString().slice(0, 10);
    for (const region of REGIONS) {
      items.push({ pk: `MON#${CHARTED}`, sk: `D#${key}#${region}`, ...day });
    }
    items.push({ pk: `MON#${CHARTED}`, sk: `UD#${key}`, minutes: 1440, down: 2 });
  }
  await put(items);

  let read = 0;
  const counted = {
    send: async (command: Parameters<typeof doc.send>[0]) => {
      const answer = (await doc.send(command)) as { Items?: unknown[] };
      read += answer.Items?.length ?? 0;
      return answer;
    },
  } as unknown as typeof doc;
  const telemetry = dynamoTelemetry(counted, "telemetry", REGIONS);

  const { points, totals } = await telemetry.series(CHARTED, seriesWindow("90d", now));
  expect(points).toHaveLength(270);
  expect(read).toBeLessThanOrEqual(300);
  expect(points.find((p) => p.at === "2026-11-01" && p.region === "eu-west-1")).toMatchObject({
    checks: 2,
    down: 1,
    maxMs: 100,
  });
  // Its uptime, read on its own: 90 days of 1440 minutes, two of each down.
  expect(await telemetry.uptime(CHARTED, seriesWindow("90d", now))).toEqual({
    minutes: 90 * 1440,
    down: 180,
  });
  // Each region's 90 days, then all three together.
  expect(totals.map((t) => [t.region, t.checks, t.down])).toEqual([
    ["eu-north-1", 180, 90],
    ["eu-west-1", 180, 90],
    ["eu-west-3", 180, 90],
    [null, 540, 270],
  ]);

  // October: 31 days of 1440 minutes, two of each down.
  expect(await telemetry.minutes(CHARTED, "2026-10", "2026-11-02")).toEqual({
    minutes: 31 * 1440,
    down: 62,
  });
  // November so far: the 1st rolled up, and the 2nd's hours until noon, one minute down in each.
  await put(
    Array.from({ length: 13 }, (_, h) => ({
      pk: `MON#${CHARTED}`,
      sk: `UH#2026-11-02T${String(h).padStart(2, "0")}`,
      minutes: 60,
      down: 1,
    })),
  );
  expect(await telemetry.minutes(CHARTED, "2026-11", "2026-11-02")).toEqual({
    minutes: 1440 + 13 * 60,
    down: 2 + 13,
  });
  // The uptime bar's 90 days end today, from its hours so far.
  const days = await telemetry.days(CHARTED, "2026-11-02");
  // Just after midnight on the 3rd, the 2nd has no day rollup yet: its hours stand in.
  const after = await telemetry.days(CHARTED, "2026-11-03");
  expect(after.slice(-2)).toEqual([
    { date: "2026-11-02", minutes: 13 * 60, minutesDown: 13 },
    { date: "2026-11-03", minutes: 0, minutesDown: 0 },
  ]);
  expect(days).toHaveLength(90);
  expect(days[0]).toEqual({ date: "2026-08-05", minutes: 1440, minutesDown: 2 });
  expect(days.at(-1)).toEqual({ date: "2026-11-02", minutes: 13 * 60, minutesDown: 13 });
});
