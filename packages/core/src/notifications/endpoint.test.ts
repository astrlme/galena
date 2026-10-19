import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  afterDelivery,
  DISABLE_AFTER_MS,
  type EndpointHealth,
  nextAttemptAt,
  resendStep,
} from "./endpoint.ts";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const later = (at: Date | undefined) => (at ? at.getTime() - T0.getTime() : undefined);

describe("nextAttemptAt", () => {
  test("a webhook is tried 8 times: 5 s, 30 s, 2 min, 10 min, 1 h, 6 h and 24 h apart", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => later(nextAttemptAt("webhook", n, T0)));
    expect(waits).toEqual([
      5 * SECOND,
      30 * SECOND,
      2 * MINUTE,
      10 * MINUTE,
      HOUR,
      6 * HOUR,
      24 * HOUR,
      undefined,
    ]);
  });

  test("a Slack message is tried 5 times within a few minutes", () => {
    const waits = [1, 2, 3, 4, 5].map((n) => later(nextAttemptAt("slack", n, T0)));
    expect(waits).toEqual([5 * SECOND, 15 * SECOND, 45 * SECOND, 135 * SECOND, undefined]);
  });
});

const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 24 * HOUR;
const active: EndpointHealth = { state: "active", failingSince: null };

describe("afterDelivery", () => {
  test("a failed delivery makes it failing; failures 3 days on turn it off", () => {
    const failing = afterDelivery(active, "failed", T0);
    expect(failing).toEqual({ state: "failing", failingSince: T0 });
    expect(afterDelivery(failing, "failed", at(3 * DAY - 1))).toEqual(failing);
    expect(afterDelivery(failing, "failed", at(3 * DAY))).toEqual({
      state: "disabled",
      failingSince: T0,
    });
  });

  test("one that gets through makes it active again, and the 3 days start over", () => {
    const failing = afterDelivery(active, "failed", T0);
    expect(afterDelivery(failing, "sent", at(2 * DAY))).toEqual(active);
    const again = afterDelivery(afterDelivery(failing, "sent", at(2 * DAY)), "failed", at(3 * DAY));
    expect(again).toEqual({ state: "failing", failingSince: at(3 * DAY) });
  });

  test("a disabled endpoint stays off until a member turns it on", () => {
    const off: EndpointHealth = { state: "disabled", failingSince: T0 };
    expect(afterDelivery(off, "sent", at(DAY))).toEqual(off);
    expect(afterDelivery(off, "failed", at(DAY))).toEqual(off);
  });
});

// Deliveries settling in order, each some time after the one before.
const history = fc.array(
  fc.record({
    outcome: fc.constantFrom("sent", "failed"),
    gap: fc.integer({ min: 0, max: 2 * DAY }),
  }),
  { maxLength: 30 },
);
const walk = (steps: { outcome: "sent" | "failed"; gap: number }[]) => {
  let now = T0.getTime();
  return steps.map(({ outcome, gap }) => {
    now += gap;
    return { outcome, at: new Date(now) };
  });
};
const replay = (settled: ReturnType<typeof walk>) =>
  settled.reduce((health, s) => afterDelivery(health, s.outcome, s.at), active);

describe("afterDelivery properties", () => {
  test("off exactly when two failures with no success between them are 3 days apart", () => {
    fc.assert(
      fc.property(history, (steps) => {
        const settled = walk(steps);
        const spans = settled.some((late, j) => {
          const lastSent = settled.slice(0, j).findLastIndex((s) => s.outcome === "sent");
          const first = settled.slice(lastSent + 1, j + 1).find((s) => s.outcome === "failed");
          return (
            late.outcome === "failed" &&
            first !== undefined &&
            late.at.getTime() - first.at.getTime() >= DISABLE_AFTER_MS
          );
        });
        expect(replay(settled).state === "disabled").toBe(spans);
      }),
      { numRuns: 2_000 },
    );
  });

  test("an endpoint that isn't off is active exactly when it has no failure since", () => {
    fc.assert(
      fc.property(history, (steps) => {
        const health = replay(walk(steps));
        if (health.state !== "disabled") {
          expect(health.state === "active").toBe(health.failingSince === null);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("resendStep", () => {
  const webhook = { kind: "webhook" as const, state: "active" as const };
  const settled = (status: "sent" | "failed" | "skipped") => ({
    status,
    attempts: 1,
    updatedAt: T0,
    notice: "the notice",
  });

  test("a sent, failed or skipped delivery can go again, but not to an endpoint that is off", () => {
    for (const status of ["sent", "failed", "skipped"] as const) {
      expect(resendStep(settled(status), webhook, T0)).toEqual({ ok: true, value: "the notice" });
    }
    const off = resendStep(settled("failed"), { kind: "webhook", state: "disabled" }, T0);
    expect(off.ok || off.error.code).toBe("endpoint_disabled");
  });

  test("one made before notices were kept has nothing to send", () => {
    const old = resendStep({ ...settled("sent"), notice: null }, webhook, T0);
    expect(old.ok || old.error.code).toBe("not_kept");
  });

  test("a pending one waits for its next attempt, unless that is 2 hours overdue", () => {
    // Attempt 7 failed at T0: attempt 8 is due 24 hours later.
    const waiting = { status: "pending" as const, attempts: 7, updatedAt: T0, notice: "n" };
    const early = resendStep(waiting, webhook, at(26 * HOUR - 1));
    expect(early.ok || early.error.code).toBe("still_retrying");
    expect(resendStep(waiting, webhook, at(26 * HOUR)).ok).toBe(true);
    // Never claimed: its first attempt was due at once.
    const unsent = { ...waiting, attempts: 0 };
    expect(resendStep(unsent, webhook, at(2 * HOUR - 1)).ok).toBe(false);
    expect(resendStep(unsent, webhook, at(2 * HOUR)).ok).toBe(true);
  });
});
