import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  eventId,
  type MonitorsFile,
  monitorsFile,
  type ProbeMessage,
  probeMessage,
  probeMessageIds,
} from "@galena/contracts";
import { checkHttp, createGuard } from "@galena/integrations/net";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type ProbeDeps, runProbe } from "./probe.ts";

// A local run: real HTTP checks against a test server, with SQS replaced by a list of batches.
let server: Server;
let origin: string;
const testGuard = createGuard({ allowAddresses: ["127.0.0.1"] });

beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(req.url === "/down" ? 503 : 200).end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const SCHEDULED = "2026-09-27T10:00:07.412Z"; // the Scheduler fired a few seconds late
const MINUTE = "2026-09-27T10:00:00.000Z";

function file(paths: string[]): MonitorsFile {
  return monitorsFile.parse({
    version: 1,
    generatedAt: "2026-09-27T09:59:00.000Z",
    monitors: paths.map((path) => ({
      id: v7(),
      workspaceId: WORKSPACE,
      type: "http",
      http: { url: `${origin}${path}` },
    })),
  });
}

function deps(overrides: Partial<ProbeDeps> = {}) {
  const batches: ProbeMessage[][] = [];
  return {
    batches,
    deps: {
      region: "eu-west-1",
      canaryUrl: `${origin}/up`,
      check: (check) => checkHttp(check, testGuard),
      send: async (batch) => {
        batches.push(batch);
      },
      newEventId: () => eventId.parse(v7()),
      now: () => new Date("2026-09-27T10:00:09.000Z"),
      ...overrides,
    } satisfies ProbeDeps,
  };
}

test("a run checks every monitor and sends the canary and results in batches of 10", async () => {
  const paths = Array.from({ length: 23 }, (_, i) => (i % 3 === 0 ? "/down" : "/up"));
  const monitors = file(paths);
  const { batches, deps: probeDeps } = deps();
  await runProbe(monitors, SCHEDULED, probeDeps);

  expect(batches.map((b) => b.length)).toEqual([10, 10, 4]);
  const messages = batches.flat().map((m) => probeMessage.parse(JSON.parse(JSON.stringify(m))));
  expect(messages[0]).toMatchObject({
    kind: "canary",
    canary: { region: "eu-west-1", scheduledAt: MINUTE, passed: true },
  });

  const checks = messages.flatMap((m) => (m.kind === "check" ? [m.result] : []));
  expect(checks.map((r) => r.monitorId)).toEqual(monitors.monitors.map((m) => m.id));
  checks.forEach((result, i) => {
    expect(result).toMatchObject({ region: "eu-west-1", scheduledAt: MINUTE });
    expect(result.status).toBe(paths[i] === "/down" ? "down" : "up");
    expect(result.httpStatus).toBe(paths[i] === "/down" ? 503 : 200);
  });

  const epochMinute = Date.parse(MINUTE) / 60_000;
  for (const message of messages.slice(1)) {
    if (message.kind !== "check") throw new Error("expected a check");
    expect(probeMessageIds(message)).toEqual({
      groupId: message.result.monitorId,
      deduplicationId: `${message.result.monitorId}#eu-west-1#${epochMinute}`,
    });
  }
  expect(new Set(checks.map((r) => r.eventId)).size).toBe(checks.length);
});

test("a failing canary is reported, and a crashing check doesn't lose the others", async () => {
  const monitors = file(["/up?first", "/up?second"]);
  const crashing = monitors.monitors[0]?.http.url;
  const { batches, deps: probeDeps } = deps({
    canaryUrl: `${origin.replace("127.0.0.1", "10.0.0.1")}/up`,
    check: async (check) => {
      if (check.url === crashing) throw new Error("bug");
      return checkHttp(check, testGuard);
    },
  });
  const { canary, results } = await runProbe(monitors, SCHEDULED, probeDeps);

  expect(canary.passed).toBe(false);
  expect(results.map((r) => [r.status, r.error?.code ?? null])).toEqual([
    ["error", "probe_failed"],
    ["up", null],
  ]);
  expect(batches.flat()).toHaveLength(3);
});

test("with no monitors, the canary still goes out", async () => {
  const { batches, deps: probeDeps } = deps();
  await runProbe(file([]), SCHEDULED, probeDeps);
  expect(batches).toEqual([[expect.objectContaining({ kind: "canary" })]]);
});
