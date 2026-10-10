import type { MonitorId } from "@galena/contracts";

// The page says "Updated" with the time it was last confirmed, and warns once that is two hours
// old. Confirming it by rebuilding from the database would wake Aurora every hour, so the hourly
// heartbeat confirms it from detection's own states instead, and wakes Aurora only when the page
// may be behind them.

/** A transition this recent may still be on its way through `monitor.state-changed`. */
export const TRANSITION_SETTLE_MS = 5 * 60_000;

/** The transition detection last recorded for a monitor. */
export type DetectedTransition = { transitionSeq: number; enteredAt: number };

/** What the last publish showed: its snapshot version and each monitor's transition seq. */
export type PublishedStates = {
  snapshotVersion: number;
  monitors: Readonly<Record<string, number>>;
};

export type HeartbeatPlan =
  /** The page shows every state detection holds: stamp it as confirmed now. */
  | { action: "confirm" }
  /** A transition is on its way; its own publish will update the page. */
  | { action: "wait"; monitorId: MonitorId }
  /** The page may be behind: catch the states up and publish, which reads the database. */
  | { action: "rollup"; reason: "no_record" | "other_snapshot" | "behind" };

export function planHeartbeat(input: {
  /** The version in the published `snapshot.json`; undefined when it is missing. */
  snapshotVersion: number | undefined;
  published: PublishedStates | undefined;
  detected: ReadonlyMap<MonitorId, DetectedTransition>;
  now: Date;
}): HeartbeatPlan {
  if (!input.published) return { action: "rollup", reason: "no_record" };
  if (input.published.snapshotVersion !== input.snapshotVersion) {
    return { action: "rollup", reason: "other_snapshot" };
  }
  const settled = input.now.getTime() - TRANSITION_SETTLE_MS;
  let waitingOn: MonitorId | undefined;
  for (const [id, recorded] of Object.entries(input.published.monitors)) {
    const detected = input.detected.get(id as MonitorId);
    if (!detected || detected.transitionSeq <= recorded) continue;
    if (detected.enteredAt <= settled) return { action: "rollup", reason: "behind" };
    waitingOn ??= id as MonitorId;
  }
  return waitingOn ? { action: "wait", monitorId: waitingOn } : { action: "confirm" };
}
