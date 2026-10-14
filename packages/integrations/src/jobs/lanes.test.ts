import { expect, test } from "vitest";
import { laneOf } from "./lanes.ts";

const monitor = "01a0fe62-03e4-73e1-a26f-64a0136ce64c";
const endpoint = "01a13c16-c4ae-769e-97e7-77b35908efb4";

test.each([
  ["outbox.dispatch", "outbox:01a1:backstop", "outbox"],
  ["page.publish", "pub:9781", "publisher"],
  ["page.heartbeat", "heartbeat:2026-10-15T10:35", "publisher"],
  ["page.rebuild-html", "html:9781", "builder"],
  ["signal.ingest", "sig:int:fp:firing:2026-10-14T20:01:00.000Z", "signals"],
  ["monitor.state-changed", `mon:${monitor}:7`, `mon:${monitor}`],
  ["notify.slack", `send:evt:${endpoint}`, `slack:${endpoint}`],
  ["notify.webhook", `send:evt:${endpoint}`, `webhook:${endpoint}`],
])("%s keyed %s runs in lane %s", (job, key, lane) => {
  expect(laneOf(job, key)).toBe(lane);
});

test("a monitor's transitions share a lane, in order, and other monitors' don't wait on it", () => {
  expect(laneOf("monitor.state-changed", `mon:${monitor}:8`)).toBe(
    laneOf("monitor.state-changed", `mon:${monitor}:9`),
  );
  expect(laneOf("monitor.state-changed", `mon:${endpoint}:8`)).not.toBe(
    laneOf("monitor.state-changed", `mon:${monitor}:8`),
  );
});

test("emails spread over five lanes, one subscriber always in the same one", () => {
  const lanes = new Set(
    Array.from({ length: 200 }, (_, i) => laneOf("notify.email", `send:evt:subscriber-${i}`)),
  );
  expect([...lanes].sort()).toEqual(["email:0", "email:1", "email:2", "email:3", "email:4"]);
  expect(laneOf("notify.email", "send:a:sub-1")).toBe(laneOf("notify.email", "send:b:sub-1"));
});

test("any other job gets a lane of its own per key, so its runs don't wait on each other", () => {
  const card = laneOf("slack.approval-card", "card:01a1");
  expect(card).toMatch(/^[0-9a-f]{64}$/);
  expect(card).toBe(laneOf("slack.approval-card", "card:01a1"));
  expect(card).not.toBe(laneOf("slack.approval-card", "card:01a2"));
});
