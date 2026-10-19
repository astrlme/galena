import type { DeliveryStatus, EndpointKind, EndpointState } from "@galena/contracts";
import { err, ok, type Result } from "../result.ts";

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

/** A pending delivery whose next attempt is this late is taken to be lost, and may go again. */
const OVERDUE_AFTER_MS = 2 * HOUR;

export type ResendRefusal = "endpoint_disabled" | "not_kept" | "still_retrying";

/**
 * Whether a member may send a delivery again now. A pending one waits for its next attempt,
 * unless that attempt is long overdue: without a way out, a lost one stays pending for good.
 * `updatedAt` is when its last attempt failed, which is when the next one was scheduled. Gives
 * back what to send: the notice the delivery kept.
 */
export function resendStep<N>(
  delivery: { status: DeliveryStatus; attempts: number; updatedAt: Date; notice: N | null },
  endpoint: { kind: EndpointKind; state: EndpointState },
  now: Date,
): Result<N, ResendRefusal> {
  if (endpoint.state === "disabled") {
    return err("endpoint_disabled", "The destination is off. Turn it on, then send this again.");
  }
  if (delivery.notice === null) {
    return err("not_kept", "It was sent before Galena kept what each delivery carried.");
  }
  if (delivery.status === "pending") {
    const due =
      nextAttemptAt(endpoint.kind, delivery.attempts, delivery.updatedAt) ?? delivery.updatedAt;
    if (now.getTime() - due.getTime() < OVERDUE_AFTER_MS) {
      return err("still_retrying", "It's still being retried. Send it again once it has failed.");
    }
  }
  return ok(delivery.notice);
}
