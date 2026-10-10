import { type MonitorId, monitorId } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type DetectedTransition, planHeartbeat, TRANSITION_SETTLE_MS } from "./heartbeat.ts";

const NOW = new Date("2026-10-10T12:35:00.000Z");
const ago = (minutes: number) => NOW.getTime() - minutes * 60_000;
const api = monitorId.parse("01920000-0000-7000-8000-000000000001");
const web = monitorId.parse("01920000-0000-7000-8000-000000000002");
const detected = (entries: [MonitorId, DetectedTransition][]) => new Map(entries);
const published = { snapshotVersion: 41, monitors: { [api]: 3, [web]: 7 } };

describe("planHeartbeat", () => {
  test("confirms the page when every monitor is where the last publish showed it", () => {
    const plan = planHeartbeat({
      snapshotVersion: 41,
      published,
      detected: detected([
        [api, { transitionSeq: 3, enteredAt: ago(300) }],
        [web, { transitionSeq: 7, enteredAt: ago(90) }],
      ]),
      now: NOW,
    });
    expect(plan).toEqual({ action: "confirm" });
  });

  test("waits while a transition is younger than five minutes: its own publish is on the way", () => {
    const plan = planHeartbeat({
      snapshotVersion: 41,
      published,
      detected: detected([[web, { transitionSeq: 8, enteredAt: ago(4) }]]),
      now: NOW,
    });
    expect(plan).toEqual({ action: "wait", monitorId: web });
  });

  test("runs the rollup when an older transition never reached the page", () => {
    const plan = planHeartbeat({
      snapshotVersion: 41,
      published,
      detected: detected([
        [api, { transitionSeq: 4, enteredAt: ago(20) }],
        [web, { transitionSeq: 8, enteredAt: ago(1) }],
      ]),
      now: NOW,
    });
    expect(plan).toEqual({ action: "rollup", reason: "behind" });
  });

  test("runs the rollup without a record of the last publish, or when the page shows another", () => {
    const fresh = detected([]);
    const plan = (snapshotVersion: number | undefined, record?: typeof published) =>
      planHeartbeat({ snapshotVersion, published: record, detected: fresh, now: NOW });
    expect(plan(41)).toEqual({ action: "rollup", reason: "no_record" });
    expect(plan(42, published)).toEqual({ action: "rollup", reason: "other_snapshot" });
    // The snapshot is missing altogether.
    expect(plan(undefined, published)).toEqual({ action: "rollup", reason: "other_snapshot" });
  });

  test("ignores monitors detection holds no state for, and ones the page never showed", () => {
    const plan = planHeartbeat({
      snapshotVersion: 41,
      published,
      detected: detected([
        [
          monitorId.parse("01920000-0000-7000-8000-000000000003"),
          { transitionSeq: 9, enteredAt: 0 },
        ],
      ]),
      now: NOW,
    });
    expect(plan).toEqual({ action: "confirm" });
  });

  test("confirms only when no settled transition is ahead of the page", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 60 }),
        (recorded, current, minutesAgo) => {
          const plan = planHeartbeat({
            snapshotVersion: 1,
            published: { snapshotVersion: 1, monitors: { [api]: recorded } },
            detected: detected([[api, { transitionSeq: current, enteredAt: ago(minutesAgo) }]]),
            now: NOW,
          });
          const ahead = current > recorded;
          const settled = minutesAgo * 60_000 >= TRANSITION_SETTLE_MS;
          expect(plan.action).toBe(!ahead ? "confirm" : settled ? "rollup" : "wait");
        },
      ),
    );
  });
});
