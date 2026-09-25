import {
  type CheckResult,
  type CheckStatus,
  type DetectionSettings,
  detectionSettings,
  eventId,
  monitorId,
} from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { type DetectionState, evaluate, initialDetectionState } from "./evaluate.ts";

const REGIONS = ["us-east-1", "eu-west-1", "ap-southeast-1"] as const;
type Region = (typeof REGIONS)[number];
const DEFAULTS = detectionSettings.parse({});
const T0 = Date.parse("2026-09-27T10:00:00.000Z");
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000a1");
const EVENT = eventId.parse("01920000-0000-7000-8000-0000000000e1");

function checkAt(region: string, status: CheckStatus, at: number, latencyMs = 120): CheckResult {
  const minute = new Date(Math.floor(at / 60_000) * 60_000).toISOString();
  const failed = status === "down" || status === "error";
  return {
    monitorId: MONITOR,
    region,
    scheduledAt: minute,
    checkedAt: new Date(at).toISOString(),
    status,
    httpStatus: status === "error" ? null : status === "down" ? 503 : 200,
    latencyMs: status === "error" ? null : latencyMs,
    phases: null,
    error: failed
      ? { code: status === "down" ? "http_status" : "probe_failed", message: "x" }
      : null,
    eventId: EVENT,
  };
}

type Step = { region: string; status: CheckStatus; at: number; latencyMs?: number };

/** Feeds steps through the reducer, evaluating each a few seconds after its minute. */
function run(steps: Step[], settings: DetectionSettings = DEFAULTS, excluded: string[] = []) {
  let state: DetectionState = initialDetectionState();
  const transitions: string[] = [];
  const evaluations = [];
  for (const step of steps) {
    const evaluation = evaluate(
      state,
      checkAt(step.region, step.status, step.at, step.latencyMs),
      settings,
      {
        clock: fixedClock(new Date(step.at + 5_000).toISOString()),
        excludedRegions: new Set(excluded),
      },
    );
    if (evaluation.transition) {
      transitions.push(`${evaluation.transition.from}→${evaluation.transition.to}`);
    }
    evaluations.push(evaluation);
    state = evaluation.next;
  }
  return { state, transitions, evaluations };
}

/** One step per region per minute; `statusOf` decides each region's result. */
function minutes(
  from: number,
  to: number,
  statusOf: (region: Region, minute: number) => CheckStatus,
  latencyMs = 120,
): Step[] {
  const steps: Step[] = [];
  for (let minute = from; minute <= to; minute++) {
    for (const region of REGIONS) {
      steps.push({ region, status: statusOf(region, minute), at: T0 + minute * 60_000, latencyMs });
    }
  }
  return steps;
}
const all = (status: CheckStatus) => () => status;
const baseline = minutes(0, 2, all("up")); // enough successes for every region to count

describe("evaluate", () => {
  test("a new monitor goes up once a quorum of regions has enough successes", () => {
    const { transitions, state } = run(baseline);
    expect(transitions).toEqual(["unknown→up"]);
    expect(state.transitionSeq).toBe(1);
  });

  test("a clean outage takes it down after two failures in a quorum of regions", () => {
    const { transitions } = run([...baseline, ...minutes(3, 4, all("down"))]);
    expect(transitions).toEqual(["unknown→up", "up→down"]);
  });

  test("a single-region blip never takes it down", () => {
    const blip = minutes(3, 12, (region) => (region === "us-east-1" ? "down" : "up"));
    expect(run([...baseline, ...blip]).transitions).toEqual(["unknown→up"]);
  });

  test("a region whose canary fails leaves the quorum", () => {
    const twoFailing = minutes(3, 6, (region) => (region === "ap-southeast-1" ? "up" : "down"));
    const steps = [...baseline, ...twoFailing];
    expect(run(steps).transitions).toEqual(["unknown→up", "up→down"]);
    expect(run(steps, DEFAULTS, ["eu-west-1"]).transitions).toEqual(["unknown→up"]);
  });

  test("with fewer eligible regions than the quorum it holds its state", () => {
    const { state, transitions, evaluations } = run(
      [...baseline, ...minutes(3, 6, all("down"))],
      DEFAULTS,
      ["eu-west-1", "ap-southeast-1"],
    );
    expect(transitions).toEqual([]);
    expect(state.state).toBe("unknown");
    expect(evaluations.at(-1)?.insufficientRegions).toBe(true);
  });

  test("probe errors never count as failures, and silent regions go stale", () => {
    const { transitions, evaluations } = run([...baseline, ...minutes(3, 12, all("error"))]);
    expect(transitions).toEqual(["unknown→up"]);
    expect(evaluations.at(-1)?.insufficientRegions).toBe(true);
  });

  test("degraded after three slow checks in most regions, and up once fast again", () => {
    const settings = detectionSettings.parse({ degradedLatencyMs: 500 });
    const { transitions } = run(
      [...baseline, ...minutes(3, 5, all("up"), 900), ...minutes(6, 6, all("up"), 100)],
      settings,
    );
    expect(transitions).toEqual(["unknown→up", "up→degraded", "degraded→up"]);
  });

  test("recovering resolves only after stableMinutes, and reopens if it fails again", () => {
    const outage = [...baseline, ...minutes(3, 4, all("down"))];
    const recovered = run([...outage, ...minutes(5, 25, all("up"))]);
    expect(recovered.transitions).toEqual([
      "unknown→up",
      "up→down",
      "down→recovering",
      "recovering→up",
    ]);
    const upAt = recovered.evaluations.find(
      (e) => e.transition?.to === "up" && e.transition.seq > 1,
    );
    const recoveringAt = recovered.evaluations.find((e) => e.transition?.to === "recovering");
    expect(
      (upAt?.next.enteredAt ?? 0) - (recoveringAt?.next.enteredAt ?? 0),
    ).toBeGreaterThanOrEqual(DEFAULTS.stableMinutes * 60_000);

    const reopened = run([...outage, ...minutes(5, 7, all("up")), ...minutes(8, 9, all("down"))]);
    expect(reopened.transitions.slice(-2)).toEqual(["down→recovering", "recovering→down"]);
  });

  test("more than four transitions in 30 minutes means flapping, left only by holding steady", () => {
    // Down for 2 minutes, up for 3, over and over.
    const flappy = minutes(3, 20, (_, minute) => ((minute - 3) % 5 < 2 ? "down" : "up"));
    const { transitions } = run([...baseline, ...flappy]);
    expect(transitions.slice(0, 6)).toEqual([
      "unknown→up",
      "up→down",
      "down→recovering",
      "recovering→down",
      "down→recovering",
      "recovering→flapping",
    ]);

    const steadyUp = run([...baseline, ...flappy, ...minutes(21, 60, all("up"))]);
    expect(steadyUp.transitions.at(-1)).toBe("flapping→up");
    const steadyDown = run([...baseline, ...flappy, ...minutes(21, 45, all("down"))]);
    expect(steadyDown.transitions.at(-1)).toBe("flapping→down");
  });
});

// docs: the monitor state machine; every other pair is a bug.
const ALLOWED = new Set([
  "unknown→up",
  "unknown→degraded",
  "unknown→down",
  "up→degraded",
  "degraded→up",
  "up→down",
  "degraded→down",
  "down→recovering",
  "recovering→up",
  "recovering→down",
  "up→flapping",
  "degraded→flapping",
  "down→flapping",
  "recovering→flapping",
  "flapping→up",
  "flapping→down",
]);

const settingsArb: fc.Arbitrary<DetectionSettings> = fc.record({
  failThreshold: fc.integer({ min: 1, max: 4 }),
  recoverThreshold: fc.integer({ min: 1, max: 4 }),
  quorum: fc.integer({ min: 1, max: 3 }),
  degradedLatencyMs: fc.option(fc.integer({ min: 100, max: 2_000 }), { nil: null }),
  staleAfterIntervals: fc.integer({ min: 1, max: 5 }),
  flapWindowMinutes: fc.integer({ min: 5, max: 60 }),
  flapMaxTransitions: fc.integer({ min: 2, max: 8 }),
  stableMinutes: fc.integer({ min: 1, max: 30 }),
});

/** Random results from the three regions with time moving forward 0–150 s between them. */
const stepsArb = (statuses: CheckStatus[]) =>
  fc
    .array(
      fc.record({
        region: fc.constantFrom(...REGIONS),
        status: fc.constantFrom(...statuses),
        latencyMs: fc.integer({ min: 0, max: 3_000 }),
        advance: fc.integer({ min: 0, max: 150_000 }),
      }),
      { maxLength: 80 },
    )
    .map((raw) => {
      let at = T0;
      return raw.map(({ advance, ...step }) => {
        at += advance;
        return { ...step, at };
      });
    });

const RUNS = { numRuns: 10_000 };

describe("detection properties", () => {
  test("only transitions from the state diagram occur, each numbered in order", () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.subarray([...REGIONS]),
        stepsArb(["up", "degraded", "down", "error"]),
        (settings, excluded, steps) => {
          const { transitions, state } = run(steps, settings, excluded);
          for (const t of transitions) expect(ALLOWED.has(t), t).toBe(true);
          expect(state.transitionSeq).toBe(transitions.length);
        },
      ),
      RUNS,
    );
  });

  test("no DOWN without a quorum of included regions that each failed failThreshold times in a row", () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.subarray([...REGIONS]),
        stepsArb(["up", "down", "error"]),
        (settings, excluded, steps) => {
          // Oracle from the raw history: the longest run of downs per region, errors skipped.
          const run_ = new Map<string, number>();
          const longest = new Map<string, number>();
          let state = initialDetectionState();
          for (const step of steps) {
            if (step.status !== "error") {
              const length = step.status === "down" ? (run_.get(step.region) ?? 0) + 1 : 0;
              run_.set(step.region, length);
              longest.set(step.region, Math.max(longest.get(step.region) ?? 0, length));
            }
            const { next, transition } = evaluate(
              state,
              checkAt(step.region, step.status, step.at),
              settings,
              {
                clock: fixedClock(new Date(step.at + 5_000).toISOString()),
                excludedRegions: new Set(excluded),
              },
            );
            if (transition?.to === "down") {
              const failedEnough = REGIONS.filter(
                (r) => !excluded.includes(r) && (longest.get(r) ?? 0) >= settings.failThreshold,
              );
              expect(failedEnough.length).toBeGreaterThanOrEqual(settings.quorum);
            }
            state = next;
          }
        },
      ),
      RUNS,
    );
  });

  test("no flip inside hysteresis: runs of downs shorter than failThreshold never take it down", () => {
    fc.assert(
      fc.property(
        settingsArb.filter((s) => s.failThreshold >= 2),
        stepsArb(["up", "down", "error"]),
        (settings, steps) => {
          // Cap every region's consecutive downs (errors skipped) at failThreshold - 1.
          const streak = new Map<string, number>();
          const capped = steps.map((step) => {
            if (step.status === "error") return step;
            const next = step.status === "down" ? (streak.get(step.region) ?? 0) + 1 : 0;
            if (next >= settings.failThreshold) {
              streak.set(step.region, 0);
              return { ...step, status: "up" as const };
            }
            streak.set(step.region, next);
            return step;
          });
          const { transitions } = run(capped, settings);
          expect(transitions.some((t) => t.endsWith("→down"))).toBe(false);
        },
      ),
      RUNS,
    );
  });

  test("probe errors never count as failures", () => {
    fc.assert(
      fc.property(settingsArb, stepsArb(["up", "degraded", "error"]), (settings, steps) => {
        const { transitions } = run(steps, settings);
        expect(transitions.some((t) => t.endsWith("→down") || t.endsWith("→recovering"))).toBe(
          false,
        );
      }),
      RUNS,
    );
  });
});
