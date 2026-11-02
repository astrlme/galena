import fc from "fast-check";
import { expect, test } from "vitest";
import { quantileOf } from "./histogram.ts";
import { mergeRollups, type RawCheck, rollUp } from "./rollup.ts";

const check = (
  region: string,
  minute: string,
  status: RawCheck["status"],
  latencyMs: number | null = status === "up" ? 100 : null,
): RawCheck => ({
  region,
  scheduledAt: `2026-11-02T13:${minute}:00.000Z`,
  status,
  latencyMs,
  phases: null,
});

test("a minute counts as down only when a quorum of regions failed; all-error minutes are no data", () => {
  const { minutes } = rollUp(
    [
      // 13:00: two of three regions down, so down.
      check("eu-west-1", "00", "down"),
      check("eu-west-3", "00", "down"),
      check("eu-north-1", "00", "up"),
      // 13:01: one region down is not an outage.
      check("eu-west-1", "01", "down"),
      check("eu-west-3", "01", "up"),
      check("eu-north-1", "01", "up"),
      // 13:02: every probe failed itself, so nobody knows.
      check("eu-west-1", "02", "error"),
      check("eu-west-3", "02", "error"),
      check("eu-north-1", "02", "error"),
    ],
    2,
  );
  expect(minutes).toEqual({ minutes: 2, down: 1 });
});

test("a region's rollup counts each status, keeps the slowest answer, and times only answers", () => {
  const phases = (dns: number, tls: number | null, ttfb: number, total: number) => ({
    dns,
    connect: 20,
    tls,
    ttfb,
    total,
  });
  const { regions } = rollUp(
    [
      { ...check("eu-west-1", "00", "up", 100), phases: phases(10, 30, 80, 100) },
      { ...check("eu-west-1", "01", "degraded", 900), phases: phases(20, null, 800, 900) },
      check("eu-west-1", "02", "down"),
      // A down answer can still carry a time (a fast 503); it is not a latency people waited for.
      check("eu-west-1", "03", "down", 40),
      check("eu-west-1", "04", "error"),
      check("eu-west-3", "00", "up", 300),
    ],
    2,
  );
  const ireland = regions.get("eu-west-1");
  expect(ireland).toMatchObject({ checks: 5, up: 1, degraded: 1, down: 2, error: 1, maxMs: 900 });
  expect(ireland?.phases).toEqual({
    dns: { sum: 30, count: 2 },
    connect: { sum: 40, count: 2 },
    tls: { sum: 30, count: 1 },
    ttfb: { sum: 880, count: 2 },
  });
  // Two answers, 100 and 900 ms: the median is the faster, within a bucket's 12%.
  const median = quantileOf(ireland?.total ?? [], 0.5) as number;
  expect(median).toBeGreaterThan(88);
  expect(median).toBeLessThan(112);
  expect(regions.get("eu-west-3")).toMatchObject({ checks: 1, up: 1, maxMs: 300 });
});

const rawCheck: fc.Arbitrary<RawCheck> = fc.record({
  region: fc.constantFrom("eu-west-1", "eu-west-3", "eu-north-1"),
  scheduledAt: fc
    .integer({ min: 0, max: 59 })
    .map((m) => `2026-11-02T13:${String(m).padStart(2, "0")}:00.000Z`),
  status: fc.constantFrom("up", "degraded", "down", "error"),
  latencyMs: fc.option(fc.integer({ min: 1, max: 60_000 }), { nil: null }),
  phases: fc.option(
    fc.record({
      dns: fc.integer({ min: 0, max: 500 }),
      connect: fc.integer({ min: 0, max: 500 }),
      tls: fc.option(fc.integer({ min: 0, max: 500 }), { nil: null }),
      ttfb: fc.integer({ min: 0, max: 5_000 }),
      total: fc.integer({ min: 0, max: 6_000 }),
    }),
    { nil: null },
  ),
});

test("a day's region rollups from its spans equal the rollup of all its checks", () => {
  // Two spans that share no minute, as two hours don't.
  const span = (hour: string) =>
    fc.array(
      rawCheck.map((c) => ({ ...c, scheduledAt: c.scheduledAt.replace("T13", `T${hour}`) })),
    );
  fc.assert(
    fc.property(span("13"), span("14"), (first, second) => {
      expect(mergeRollups(rollUp(first, 2), rollUp(second, 2))).toEqual(
        rollUp([...first, ...second], 2),
      );
    }),
  );
});
