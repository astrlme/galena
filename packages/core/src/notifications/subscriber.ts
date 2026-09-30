import type { SubscriberState } from "@galena/contracts";
import { err, ok, type Result } from "../result.ts";

// An email subscriber's life: double opt-in, one-click unsubscribe, and suppression when SES
// reports a hard bounce or a complaint. Suppressed is for good; a member can remove the row.

/** A confirmation link works for 7 days; after that the pending row expires too. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60_000;
/** At most one confirmation email per address in this long, however often the form is sent. */
export const RESEND_AFTER_MS = 10 * 60_000;

export type SubscriberStage = { state: SubscriberState; confirmSentAt: Date | null };

/** Someone submits the form with this address (`current` undefined when it's new). */
export function subscribeStep(
  current: SubscriberStage | undefined,
  now: Date,
): { state: SubscriberState; sendConfirmation: boolean } {
  if (current?.state === "active" || current?.state === "suppressed") {
    return { state: current.state, sendConfirmation: false };
  }
  // Counted whatever happened since, so unsubscribing and subscribing again can't be used to
  // flood an inbox; the last email's link still works, as the row is pending again.
  const sentRecently =
    current?.confirmSentAt != null &&
    now.getTime() - current.confirmSentAt.getTime() < RESEND_AFTER_MS;
  return { state: "pending_confirmation", sendConfirmation: !sentRecently };
}

/** A confirmation link issued at `issuedAt` is followed. Following it twice is harmless. */
export function confirmStep(
  current: SubscriberStage,
  issuedAt: Date,
  now: Date,
): Result<"active", "expired" | "not_pending"> {
  if (now.getTime() - issuedAt.getTime() >= CONFIRM_TTL_MS) {
    return err("expired", "This link has expired. Subscribe again to get a new one.");
  }
  if (current.state !== "pending_confirmation" && current.state !== "active") {
    return err("not_pending", "This subscription is no longer waiting for confirmation.");
  }
  return ok("active");
}

/** The unsubscribe link or one-click header. A suppressed address stays suppressed. */
export function unsubscribeStep(state: SubscriberState): SubscriberState {
  return state === "suppressed" ? "suppressed" : "unsubscribed";
}
