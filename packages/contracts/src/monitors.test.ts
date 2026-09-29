import { expect, test } from "vitest";
import {
  checkDeduplicationId,
  checkResult,
  detectionSettings,
  monitorConfig,
  monitorsFile,
  probeMessage,
  probeMessageIds,
} from "./monitors.ts";

const ids = {
  monitor: "01920000-0000-7000-8000-0000000000a1",
  workspace: "01920000-0000-7000-8000-000000000001",
  component: "01920000-0000-7000-8000-000000000011",
  event: "01920000-0000-7000-8000-0000000000e1",
};

const minimalMonitor = {
  id: ids.monitor,
  workspaceId: ids.workspace,
  componentId: ids.component,
  name: "API",
  type: "http",
  http: { url: "https://api.example.com/health" },
};

/** A schema round-trips when its output, sent through JSON, parses back to itself. */
function roundTrips<T>(schema: { parse: (v: unknown) => T }, input: unknown) {
  const once = schema.parse(input);
  expect(schema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  return once;
}

test("a minimal monitor gets the documented defaults and round-trips", () => {
  const monitor = roundTrips(monitorConfig, minimalMonitor);
  expect(monitor).toMatchObject({
    publishPolicy: "approve",
    downStatus: "major_outage",
    enabled: true,
    http: { method: "GET", timeoutMs: 10_000, followRedirects: true },
    detection: {
      failThreshold: 2,
      recoverThreshold: 3,
      quorum: 2,
      degradedLatencyMs: null,
      staleAfterIntervals: 3,
      flapWindowMinutes: 30,
      flapMaxTransitions: 4,
      stableMinutes: 15,
    },
  });
});

test.each([
  ["a file URL", { http: { url: "file:///etc/passwd" } }],
  ["an FTP URL", { http: { url: "ftp://example.com/" } }],
  ["credentials in the URL", { http: { url: "https://user:secret@example.com/" } }],
  ["a timeout over 10 s", { http: { url: "https://example.com/", timeoutMs: 30_000 } }],
  [
    "a status code that is not HTTP",
    { http: { url: "https://example.com/", expectedStatus: [99] } },
  ],
  ["an unknown publish policy", { publishPolicy: "always" }],
  ["a down status that is not an outage", { downStatus: "degraded_performance" }],
  ["a quorum of zero", { detection: { quorum: 0 } }],
  ["a monitor type that does not exist yet", { type: "tcp" }],
  ["a blank name", { name: "  " }],
])("rejects a monitor with %s", (_, change) => {
  expect(monitorConfig.safeParse({ ...minimalMonitor, ...change }).success).toBe(false);
});

test("detection settings can be tuned per monitor", () => {
  expect(detectionSettings.parse({ quorum: 3, degradedLatencyMs: 800 })).toMatchObject({
    quorum: 3,
    degradedLatencyMs: 800,
    failThreshold: 2,
  });
});

test("monitors.json carries only what the hot path needs and round-trips", () => {
  const file = roundTrips(monitorsFile, {
    version: 1,
    generatedAt: "2026-09-27T10:00:00.000Z",
    monitors: [
      {
        id: ids.monitor,
        workspaceId: ids.workspace,
        type: "http",
        http: { url: "https://api.example.com/health" },
        downStatus: "partial_outage",
        detection: {},
      },
    ],
  });
  expect(Object.keys(file.monitors[0] ?? {}).sort()).toEqual(
    ["detection", "downStatus", "http", "id", "maintenance", "type", "workspaceId"].sort(),
  );
  expect(monitorsFile.safeParse({ ...file, version: 2 }).success).toBe(false);
});

const upResult = {
  monitorId: ids.monitor,
  region: "eu-west-1",
  scheduledAt: "2026-09-27T10:00:00.000Z",
  checkedAt: "2026-09-27T10:00:01.250Z",
  status: "up",
  httpStatus: 200,
  latencyMs: 182,
  phases: { dns: 12, connect: 30, tls: 45, ttfb: 170, total: 182 },
  error: null,
  eventId: ids.event,
};

test("an up check result round-trips", () => {
  roundTrips(checkResult, upResult);
});

test("a down or error result needs an error code, and an up result must not have one", () => {
  const down = {
    ...upResult,
    status: "down",
    httpStatus: 503,
    error: { code: "http_status", message: "Expected 2xx, got 503" },
  };
  roundTrips(checkResult, down);
  expect(checkResult.safeParse({ ...down, error: null }).success).toBe(false);
  expect(checkResult.safeParse({ ...upResult, error: down.error }).success).toBe(false);
  const probeFailed = {
    ...upResult,
    status: "error",
    httpStatus: null,
    latencyMs: null,
    phases: null,
    error: { code: "probe_failed", message: "Out of memory" },
  };
  roundTrips(checkResult, probeFailed);
});

test.each([
  ["an unknown region", { region: "moon-1" }],
  ["an unknown error code", { status: "down", error: { code: "oops", message: "?" } }],
  ["a local time instead of UTC", { scheduledAt: "2026-09-27T12:00:00+02:00" }],
  ["negative latency", { latencyMs: -1 }],
])("rejects a check result with %s", (_, change) => {
  expect(checkResult.safeParse({ ...upResult, ...change }).success).toBe(false);
});

test("the FIFO deduplication id uses the scheduled minute, not when the check ran", () => {
  const result = checkResult.parse({ ...upResult, checkedAt: "2026-09-27T10:00:59.900Z" });
  const late = checkResult.parse({ ...upResult, checkedAt: "2026-09-27T10:01:03.000Z" });
  expect(checkDeduplicationId(result)).toBe(
    `${ids.monitor}#eu-west-1#${1_790_503_200_000 / 60_000}`,
  );
  expect(checkDeduplicationId(late)).toBe(checkDeduplicationId(result));
});

test("probe messages group checks by monitor and canaries by region", () => {
  const check = probeMessage.parse({ kind: "check", result: upResult });
  expect(probeMessageIds(check)).toEqual({
    groupId: ids.monitor,
    deduplicationId: `${ids.monitor}#eu-west-1#${1_790_503_200_000 / 60_000}`,
  });
  const canary = probeMessage.parse({
    kind: "canary",
    canary: {
      region: "eu-west-1",
      scheduledAt: upResult.scheduledAt,
      passed: false,
      eventId: upResult.eventId,
    },
  });
  expect(probeMessageIds(canary)).toEqual({
    groupId: "canary#eu-west-1",
    deduplicationId: `canary#eu-west-1#${1_790_503_200_000 / 60_000}`,
  });
  expect(probeMessage.safeParse({ kind: "heartbeat" }).success).toBe(false);
});
