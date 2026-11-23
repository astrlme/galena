import fc from "fast-check";
import { expect, test } from "vitest";
import { componentMinutes, errorBudget, minutesLeftIn, monthOf } from "./report.ts";
import { mergeRollups, type RawCheck, type Rollup, rollUp } from "./rollup.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const HOUR = 3_600_000;

const result = fc.record({
  status: fc.constantFrom("up", "degraded", "down", "error"),
  latencyMs: fc.option(fc.integer({ min: 1, max: 60_000 }), { nil: null }),
});

/** Checks scattered over a few days of a month: some minutes, each with 1 to 3 regions' results. */
const month = fc
  .uniqueArray(fc.integer({ min: 0, max: 3 * 24 * 60 - 1 }), { maxLength: 200 })
  .chain((minutes) =>
    fc.tuple(
      ...minutes.map((m) =>
        fc
          .subarray(REGIONS, { minLength: 1 })
          .chain((regions) => fc.tuple(...regions.map(() => result)))
          .map((results) =>
            results.map(
              (r, i): RawCheck => ({
                region: REGIONS[i] as string,
                scheduledAt: new Date(Date.UTC(2026, 9, 1) + m * 60_000).toISOString(),
                status: r.status,
                latencyMs: r.status === "up" || r.status === "degraded" ? r.latencyMs : null,
                phases: null,
              }),
            ),
          ),
      ),
    ),
  )
  .map((minutes) => minutes.flat());

// Each hour rolled up on its own and each day from its hours, as the hourly rollup does.
function days(checks: RawCheck[], quorum: number): Rollup[] {
  const byHour = Map.groupBy(checks, (c) => Math.floor(Date.parse(c.scheduledAt) / HOUR));
  const hours = [...byHour.values()].map((cs) => ({
    day: cs[0]?.scheduledAt.slice(0, 10),
    rollup: rollUp(cs, quorum),
  }));
  return [...Map.groupBy(hours, (h) => h.day).values()].map((hs) =>
    hs.map((h) => h.rollup).reduce(mergeRollups),
  );
}

// Counted straight from the raw checks, the way the task states it.
function counted(checks: RawCheck[], quorum: number) {
  const byMinute = Map.groupBy(
    checks.filter((c) => c.status !== "error"),
    (c) => c.scheduledAt,
  );
  const down = [...byMinute.values()].filter(
    (cs) => cs.filter((c) => c.status === "down").length >= quorum,
  ).length;
  const answers = checks
    .flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]))
    .toSorted((a, b) => a - b);
  const p95 = answers[Math.max(0, Math.ceil(0.95 * answers.length) - 1)] ?? null;
  return { minutes: byMinute.size, minutesDown: down, p95 };
}

test("a month from its daily rollups matches a count of its raw checks", () => {
  fc.assert(
    fc.property(month, fc.integer({ min: 1, max: 3 }), (checks, quorum) => {
      const rolled = days(checks, quorum);
      const report = monthOf({
        minutes: rolled.map((d) => d.minutes),
        regions: rolled.flatMap((d) => [...d.regions.values()]),
      });
      const truth = counted(checks, quorum);
      expect(report.minutes).toBe(truth.minutes);
      expect(report.minutesDown).toBe(truth.minutesDown);
      if (truth.p95 === null) expect(report.p95Ms).toBeNull();
      // The histogram's 12% bound, plus the rounding to a whole millisecond.
      else
        expect(Math.abs((report.p95Ms as number) - truth.p95)).toBeLessThanOrEqual(
          truth.p95 * 0.12 + 1,
        );
    }),
    { numRuns: 300 },
  );
});

test("a finished month's budget is the target's share of its checked minutes, less those down", () => {
  // October: 44,640 minutes, 99.9% allows 44 of them down.
  expect(errorBudget({ minutes: 44_640, down: 12 }, 99.9, 0)).toEqual({
    allowedMinutes: 44,
    leftMinutes: 32,
  });
  // 0.1% of 1,000 minutes is one whole minute, however the float rounds.
  expect(errorBudget({ minutes: 1_000, down: 0 }, 99.9, 0)).toEqual({
    allowedMinutes: 1,
    leftMinutes: 1,
  });
});

test("a running month counts the minutes still to come, and an overspent budget goes below zero", () => {
  // 10,000 minutes checked and 30,000 to come: 99.9% allows 40, and 50 are already down.
  expect(errorBudget({ minutes: 10_000, down: 50 }, 99.9, 30_000)).toEqual({
    allowedMinutes: 40,
    leftMinutes: -10,
  });
});

test("minutes left in a month: none once it is over, all of it before it starts", () => {
  // From 24 November 12:00 to 1 December: six and a half days.
  expect(minutesLeftIn("2026-11", new Date("2026-11-24T12:00:00.000Z"))).toBe(9_360);
  expect(minutesLeftIn("2026-10", new Date("2026-11-24T12:00:00.000Z"))).toBe(0);
  expect(minutesLeftIn("2026-12", new Date("2026-11-24T12:00:00.000Z"))).toBe(44_640);
});

test("a component's minutes: every measured minute counts, outages down, maintenance up", () => {
  expect(
    componentMinutes([
      { operational: 1400.5, partial_outage: 39.5 },
      { operational: 1380, under_maintenance: 50, major_outage: 10 },
      { degraded_performance: 0.4 },
    ]),
  ).toEqual({ minutes: 2880.4, down: 49 });
});
