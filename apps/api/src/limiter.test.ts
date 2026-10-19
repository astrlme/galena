import { expect, test } from "vitest";
import { createLimiter } from "./limiter.ts";

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, pass: (ms: number) => (t += ms) };
};

test("lets max through in a window, then refuses until the oldest falls out of it", () => {
  const time = clock();
  const take = createLimiter({ max: 3, windowMs: 60_000, now: time.now });
  expect([take("a"), take("a"), take("a"), take("a")]).toEqual([true, true, true, false]);
  time.pass(59_999);
  expect(take("a")).toBe(false);
  time.pass(1);
  expect(take("a")).toBe(true);
});

test("counts each key apart, and a take can spend several at once", () => {
  const take = createLimiter({ max: 10, windowMs: 60_000, now: clock().now });
  expect(take("hook-1", 8)).toBe(true);
  expect(take("hook-1", 3)).toBe(false);
  expect(take("hook-1", 2)).toBe(true);
  expect(take("hook-2", 10)).toBe(true);
});

test("holds at most maxKeys keys, forgetting the one seen longest ago", () => {
  const take = createLimiter({ max: 1, windowMs: 60_000, maxKeys: 2, now: clock().now });
  expect([take("a"), take("b"), take("c")]).toEqual([true, true, true]);
  // "a" was forgotten to make room for "c", so it starts over; "c" is still counted.
  expect([take("a"), take("c")]).toEqual([true, false]);
});
