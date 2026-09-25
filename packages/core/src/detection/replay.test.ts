/// <reference types="node" />
// `pnpm replay`: every `<scenario>.jsonl` in test/fixtures/replay goes through the real reducer
// and must produce exactly the transitions in `<scenario>.expected.json`. One event per line, in
// time order (see `Line`); expected transitions are worked out by hand, never copied from a run.
import { readdirSync, readFileSync } from "node:fs";
import {
  type CheckStatus,
  checkResult,
  type DetectionSettings,
  detectionSettings,
  eventId,
  monitorId,
} from "@galena/contracts";
import { expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { type CanaryTrack, nextCanary } from "./canary.ts";
import { evaluate, initialDetectionState } from "./evaluate.ts";

const FIXTURES = new URL("../../../../test/fixtures/replay/", import.meta.url);
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000a1");
const EVENT = eventId.parse("01920000-0000-7000-8000-0000000000e1");
/** Checks are evaluated a few seconds after their scheduled minute. */
const EVALUATION_DELAY = 5_000;

type Line =
  | { type: "settings"; detection: Partial<DetectionSettings> }
  | { type: "check"; at: string; region: string; status: CheckStatus; latencyMs?: number }
  | { type: "canary"; at: string; region: string; passed: boolean }
  | { type: "maintenance"; at: string; active: boolean };

type Replayed = { at: string; from: string; to: string; suppressed: boolean };

function replay(lines: Line[]): Replayed[] {
  let settings = detectionSettings.parse({});
  let state = initialDetectionState();
  const canaries = new Map<string, CanaryTrack>();
  let inMaintenance = false;
  const transitions: Replayed[] = [];

  for (const line of lines) {
    switch (line.type) {
      case "settings":
        settings = detectionSettings.parse(line.detection);
        break;
      case "canary":
        canaries.set(
          line.region,
          nextCanary(canaries.get(line.region) ?? { excluded: false, passes: 0 }, line.passed),
        );
        break;
      case "maintenance":
        inMaintenance = line.active;
        break;
      case "check": {
        const failed = line.status === "down" || line.status === "error";
        const result = checkResult.parse({
          monitorId: MONITOR,
          region: line.region,
          scheduledAt: line.at,
          checkedAt: line.at,
          status: line.status,
          httpStatus: line.status === "error" ? null : line.status === "down" ? 503 : 200,
          latencyMs: line.status === "error" ? null : (line.latencyMs ?? 150),
          phases: null,
          error: failed
            ? { code: line.status === "down" ? "http_status" : "probe_failed", message: "replay" }
            : null,
          eventId: EVENT,
        });
        const excludedRegions = new Set(
          [...canaries].filter(([, track]) => track.excluded).map(([region]) => region),
        );
        const clock = fixedClock(new Date(Date.parse(line.at) + EVALUATION_DELAY).toISOString());
        const { next, transition } = evaluate(state, result, settings, {
          clock,
          excludedRegions,
          inMaintenance,
        });
        if (transition) {
          transitions.push({
            at: new Date(transition.at).toISOString(),
            from: transition.from,
            to: transition.to,
            suppressed: transition.suppressed,
          });
        }
        state = next;
        break;
      }
      default:
        throw new Error(`Unknown replay line: ${JSON.stringify(line)}`);
    }
  }
  return transitions;
}

const scenarios = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".jsonl"))
  .map((file) => file.replace(/\.jsonl$/, ""));

test("the six required scenarios are present", () => {
  expect(scenarios).toEqual(
    expect.arrayContaining([
      "clean-outage",
      "single-region-blip",
      "probe-region-down",
      "flapping-endpoint",
      "latency-degradation",
      "outage-during-maintenance",
    ]),
  );
});

test.each(scenarios)("%s replays to exactly its expected transitions", (name) => {
  const lines = readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
  const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, FIXTURES), "utf8"));
  expect(replay(lines)).toEqual(expected);
});
