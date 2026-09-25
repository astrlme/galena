import type { CheckResult, DetectionSettings, MonitorState } from "@galena/contracts";
import { assertNever } from "../assert-never.ts";
import type { Clock } from "../ports.ts";

// Detection: one check result in, the monitor's next state out. Pure, so the evaluator, the
// replay harness and the property tests all run exactly this code.

/** Consecutive slow checks before a region counts as slow. */
const SLOW_CHECKS = 3;
const MINUTE = 60_000;

export type RegionTrack = {
  failures: number;
  successes: number;
  /** Changes only after failThreshold failures or recoverThreshold successes in a row. */
  verdict: "unknown" | "healthy" | "failing";
  slowChecks: number;
  /** Scheduled minute of the region's last up, degraded or down result (epoch ms). */
  lastSeenAt: number;
};

type Signal = { failing: boolean; since: number };

export type DetectionState = {
  state: MonitorState;
  enteredAt: number;
  transitionSeq: number;
  /** Transition times (epoch ms) inside the flap window, oldest first. */
  recentTransitions: number[];
  /** Whether a quorum is failing, and since when; recovery and flapping exits wait on it. */
  signal: Signal | null;
  regions: Record<string, RegionTrack>;
};

export type Transition = { from: MonitorState; to: MonitorState; seq: number; at: number };

export type Evaluation = {
  next: DetectionState;
  transition: Transition | null;
  /** Fewer eligible regions than the quorum: the state was held. Emit `probe.degraded`. */
  insufficientRegions: boolean;
};

export function initialDetectionState(): DetectionState {
  return {
    state: "unknown",
    enteredAt: 0,
    transitionSeq: 0,
    recentTransitions: [],
    signal: null,
    regions: {},
  };
}

function track(previous: RegionTrack | undefined, result: CheckResult, s: DetectionSettings) {
  const prev = previous ?? {
    failures: 0,
    successes: 0,
    verdict: "unknown" as const,
    slowChecks: 0,
    lastSeenAt: 0,
  };
  const failed = result.status === "down";
  const failures = failed ? prev.failures + 1 : 0;
  const successes = failed ? 0 : prev.successes + 1;
  const slow =
    !failed &&
    s.degradedLatencyMs !== null &&
    result.latencyMs !== null &&
    result.latencyMs > s.degradedLatencyMs;
  return {
    failures,
    successes,
    verdict:
      failures >= s.failThreshold
        ? ("failing" as const)
        : successes >= s.recoverThreshold
          ? ("healthy" as const)
          : prev.verdict,
    slowChecks: slow ? prev.slowChecks + 1 : 0,
    lastSeenAt: Date.parse(result.scheduledAt),
  };
}

function target(
  state: MonitorState,
  signal: "failing" | "slow" | "ok",
  steadyFor: number,
  s: DetectionSettings,
): MonitorState {
  const ongoing = signal === "failing" ? "down" : signal === "slow" ? "degraded" : "up";
  switch (state) {
    case "unknown":
    case "up":
    case "degraded":
      return ongoing;
    case "down":
      return signal === "failing" ? "down" : "recovering";
    case "recovering":
      if (signal === "failing") return "down";
      return steadyFor >= s.stableMinutes * MINUTE ? "up" : "recovering";
    case "flapping":
      // Leave only by holding steady, so a real outage can't hide here for long.
      if (signal === "failing") return steadyFor >= s.stableMinutes * MINUTE ? "down" : "flapping";
      return steadyFor >= s.flapWindowMinutes * MINUTE ? "up" : "flapping";
    default:
      return assertNever(state);
  }
}

export function evaluate(
  previous: DetectionState,
  result: CheckResult,
  s: DetectionSettings,
  context: { clock: Clock; excludedRegions: ReadonlySet<string> },
): Evaluation {
  const now = context.clock.now().getTime();

  // A probe error says nothing about the target: no streak moves and the region is not
  // refreshed, so a region that only errors goes stale and leaves the quorum.
  const regions =
    result.status === "error"
      ? previous.regions
      : { ...previous.regions, [result.region]: track(previous.regions[result.region], result, s) };

  const freshAfter = now - s.staleAfterIntervals * MINUTE;
  const eligible = Object.entries(regions)
    .filter(
      ([name, r]) =>
        r.verdict !== "unknown" && r.lastSeenAt >= freshAfter && !context.excludedRegions.has(name),
    )
    .map(([, r]) => r);
  if (eligible.length < s.quorum) {
    return { next: { ...previous, regions }, transition: null, insufficientRegions: true };
  }

  const failing = eligible.filter((r) => r.verdict === "failing").length;
  const slow = eligible.filter(
    (r) => r.verdict !== "failing" && r.slowChecks >= SLOW_CHECKS,
  ).length;
  // "Slow" means the median region is slow: more than half of the eligible ones.
  const signal = failing >= s.quorum ? "failing" : slow * 2 > eligible.length ? "slow" : "ok";
  const isFailing = signal === "failing";
  const steady: Signal =
    previous.signal && previous.signal.failing === isFailing
      ? previous.signal
      : { failing: isFailing, since: now };

  let to = target(previous.state, signal, now - steady.since, s);
  if (to === previous.state) {
    return {
      next: { ...previous, regions, signal: steady },
      transition: null,
      insufficientRegions: false,
    };
  }

  // Leaving `unknown` only means detection started, so it is not evidence of flapping.
  const recent = [
    ...previous.recentTransitions.filter((at) => at > now - s.flapWindowMinutes * MINUTE),
    ...(previous.state === "unknown" ? [] : [now]),
  ];
  if (
    previous.state !== "unknown" &&
    previous.state !== "flapping" &&
    recent.length > s.flapMaxTransitions
  ) {
    to = "flapping";
  }
  const seq = previous.transitionSeq + 1;
  return {
    next: {
      state: to,
      enteredAt: now,
      transitionSeq: seq,
      recentTransitions: recent,
      signal: steady,
      regions,
    },
    transition: { from: previous.state, to, seq, at: now },
    insufficientRegions: false,
  };
}
