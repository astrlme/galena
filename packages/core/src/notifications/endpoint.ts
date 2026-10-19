import type { EndpointKind, EndpointState } from "@galena/contracts";

// A Slack channel or webhook receiver that stops answering: how long each delivery keeps
// trying, and when the endpoint is failing or turned off.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * The waits between a delivery's attempts. A webhook receiver may be down for a day and still
 * want the record; a Slack message hours late would only confuse the channel.
 */
const RETRY_WAITS_MS: Record<EndpointKind, readonly number[]> = {
  webhook: [5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  slack: [5 * SECOND, 15 * SECOND, 45 * SECOND, 135 * SECOND],
};

/** When attempt `attempt + 1` runs after attempt `attempt` (from 1) failed; none after the last. */
export function nextAttemptAt(kind: EndpointKind, attempt: number, now: Date): Date | undefined {
  const wait = RETRY_WAITS_MS[kind][attempt - 1];
  return wait === undefined ? undefined : new Date(now.getTime() + wait);
}

/** Failing this long, through every delivery's retries, and the endpoint is turned off. */
export const DISABLE_AFTER_MS = 3 * 24 * HOUR;

/** `failingSince`: when its first delivery failed for good since the last one got through. */
export type EndpointHealth = { state: EndpointState; failingSince: Date | null };

/** A delivery to the endpoint settled: it got through, or failed after its last attempt. */
export function afterDelivery(
  current: EndpointHealth,
  outcome: "sent" | "failed",
  now: Date,
): EndpointHealth {
  // Deliveries skip a disabled endpoint; only a member turns it back on.
  if (current.state === "disabled") return current;
  if (outcome === "sent") return { state: "active", failingSince: null };
  const since = current.failingSince ?? now;
  if (now.getTime() - since.getTime() >= DISABLE_AFTER_MS) {
    return { state: "disabled", failingSince: since };
  }
  return { state: "failing", failingSince: since };
}
