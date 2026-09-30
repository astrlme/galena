import type { SubscriberState } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CONFIRM_TTL_MS,
  confirmStep,
  RESEND_AFTER_MS,
  type SubscriberStage,
  subscribeStep,
  unsubscribeStep,
} from "./subscriber.ts";

const T0 = new Date("2026-09-30T12:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

describe("subscribeStep", () => {
  test("a new address waits for confirmation and gets one email", () => {
    expect(subscribeStep(undefined, T0)).toEqual({
      state: "pending_confirmation",
      sendConfirmation: true,
    });
  });

  test("asking again within 10 minutes sends nothing more", () => {
    const pending: SubscriberStage = { state: "pending_confirmation", confirmSentAt: T0 };
    expect(subscribeStep(pending, after(9 * MINUTE)).sendConfirmation).toBe(false);
    expect(subscribeStep(pending, after(RESEND_AFTER_MS)).sendConfirmation).toBe(true);
  });

  test("someone who unsubscribed starts over; active and suppressed addresses stay as they are", () => {
    const stage = (state: SubscriberState): SubscriberStage => ({ state, confirmSentAt: T0 });
    expect(subscribeStep(stage("unsubscribed"), after(RESEND_AFTER_MS))).toEqual({
      state: "pending_confirmation",
      sendConfirmation: true,
    });
    expect(subscribeStep(stage("active"), after(MINUTE))).toEqual({
      state: "active",
      sendConfirmation: false,
    });
    expect(subscribeStep(stage("suppressed"), after(MINUTE))).toEqual({
      state: "suppressed",
      sendConfirmation: false,
    });
  });
});

// Found by the property below: unsubscribing between two requests must not reset the limit.
test("subscribe, unsubscribe, subscribe within 10 minutes sends one email", () => {
  const first = subscribeStep(undefined, T0);
  const again = subscribeStep({ state: unsubscribeStep(first.state), confirmSentAt: T0 }, T0);
  expect([first.sendConfirmation, again]).toEqual([
    true,
    { state: "pending_confirmation", sendConfirmation: false },
  ]);
});

describe("confirmStep", () => {
  const pending: SubscriberStage = { state: "pending_confirmation", confirmSentAt: T0 };

  test("a link from the last 7 days activates a pending subscriber, and again is harmless", () => {
    expect(confirmStep(pending, T0, after(CONFIRM_TTL_MS - 1))).toEqual({
      ok: true,
      value: "active",
    });
    expect(confirmStep({ ...pending, state: "active" }, T0, after(MINUTE)).ok).toBe(true);
  });

  test("an old link, or one for someone who has since unsubscribed, does nothing", () => {
    expect(confirmStep(pending, T0, after(CONFIRM_TTL_MS))).toMatchObject({
      ok: false,
      error: { code: "expired" },
    });
    for (const state of ["unsubscribed", "suppressed"] as const) {
      expect(confirmStep({ ...pending, state }, T0, after(MINUTE))).toMatchObject({
        ok: false,
        error: { code: "not_pending" },
      });
    }
  });
});

test("unsubscribing is final for everyone but a suppressed address, which stays suppressed", () => {
  expect(unsubscribeStep("active")).toBe("unsubscribed");
  expect(unsubscribeStep("pending_confirmation")).toBe("unsubscribed");
  expect(unsubscribeStep("unsubscribed")).toBe("unsubscribed");
  expect(unsubscribeStep("suppressed")).toBe("suppressed");
});

// Any sequence of requests, confirmations, unsubscribes and bounces, at any spacing.
const action = fc.oneof(
  fc.record({ kind: fc.constant("subscribe" as const), wait: fc.nat(20 * MINUTE) }),
  fc.record({
    kind: fc.constant("confirm" as const),
    wait: fc.nat(8 * 24 * 60 * MINUTE),
    linkAge: fc.nat(8 * 24 * 60 * MINUTE),
  }),
  fc.record({ kind: fc.constant("unsubscribe" as const), wait: fc.nat(MINUTE) }),
  fc.record({ kind: fc.constant("bounce" as const), wait: fc.nat(MINUTE) }),
);

test("never sends confirmations closer than 10 minutes, and only confirming activates", () => {
  fc.assert(
    fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
      let now = T0.getTime();
      let stage: SubscriberStage | undefined;
      let lastSent = Number.NEGATIVE_INFINITY;
      for (const a of actions) {
        now += a.wait;
        const before = stage?.state;
        if (a.kind === "subscribe") {
          const next = subscribeStep(stage, new Date(now));
          if (next.sendConfirmation) {
            expect(now - lastSent).toBeGreaterThanOrEqual(RESEND_AFTER_MS);
            expect(next.state).toBe("pending_confirmation");
            lastSent = now;
          }
          stage = {
            state: next.state,
            confirmSentAt: next.sendConfirmation ? new Date(now) : (stage?.confirmSentAt ?? null),
          };
          if (next.state === "active") expect(before).toBe("active");
        } else if (stage && a.kind === "confirm") {
          const result = confirmStep(stage, new Date(now - a.linkAge), new Date(now));
          if (result.ok) {
            expect(["pending_confirmation", "active"]).toContain(before);
            expect(a.linkAge).toBeLessThan(CONFIRM_TTL_MS);
            stage = { ...stage, state: result.value };
          }
        } else if (stage && a.kind === "unsubscribe") {
          stage = { ...stage, state: unsubscribeStep(stage.state) };
        } else if (stage && a.kind === "bounce") {
          stage = { ...stage, state: "suppressed" };
        }
        // Suppressed is for good: nothing a visitor does brings the address back.
        if (before === "suppressed") expect(stage?.state).toBe("suppressed");
      }
    }),
    { numRuns: 10_000 },
  );
});
