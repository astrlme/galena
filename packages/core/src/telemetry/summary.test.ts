import { expect, test } from "vitest";
import { type RawCheck, rollUp } from "./rollup.ts";
import { summarize, summaryWindow } from "./summary.ts";

const LAST = Date.parse("2026-11-03T10:00:00.000Z");
const HOUR = 3_600_000;

/** One region's hour of answers taking the given times. */
const hourOf = (at: string, region: string, latencies: number[]) => {
  const checks: RawCheck[] = latencies.map((ms, n) => ({
    region,
    scheduledAt: `${at}:${String(n).padStart(2, "0")}:00.000Z`,
    status: "up",
    latencyMs: ms,
    phases: null,
  }));
  const rollup = rollUp(checks, 2).regions.get(region) ?? expect.fail("no rollup");
  return { at, rollup };
};

test("a summary reads the 23 hours before the last, the 29 days before its day, and its day so far", () => {
  expect(summaryWindow(LAST)).toEqual({
    hours: { from: "2026-11-02T11", to: "2026-11-03T09" },
    days: { from: "2026-10-05", to: "2026-11-02" },
    today: { from: "2026-11-03T00", to: "2026-11-03T09" },
  });
  // The day's first hour has nothing earlier that day to read.
  expect(summaryWindow(Date.parse("2026-11-03T00:00:00.000Z")).today).toBeNull();
});

test("each hour's median takes every region's answers together; an hour without any is null", () => {
  const summary = summarize(
    LAST,
    [
      hourOf("2026-11-03T10", "eu-west-1", [100, 100, 100]),
      hourOf("2026-11-03T10", "eu-west-3", [900, 900, 900, 900]),
      hourOf("2026-11-02T11", "eu-west-1", [200]),
    ],
    [],
  );
  expect(summary.through).toBe("2026-11-03T10");
  expect(summary.hourlyMedianMs).toHaveLength(24);
  // The oldest hour first, the last hour last; the hours between had no answers.
  expect(summary.hourlyMedianMs[0]).toBeGreaterThan(200 * 0.88);
  expect(summary.hourlyMedianMs[0]).toBeLessThan(200 * 1.12);
  expect(summary.hourlyMedianMs.slice(1, 23)).toEqual(Array.from({ length: 22 }, () => null));
  // Four of seven answers took 900 ms, so the median is 900, not either region's alone.
  expect(summary.hourlyMedianMs[23]).toBeGreaterThan(900 * 0.88);
  expect(summary.hourlyMedianMs[23]).toBeLessThan(900 * 1.12);
});

test("the p95 covers all 24 hours, and an hour outside them counts for nothing", () => {
  const fast = Array.from({ length: 9 }, (_, n) =>
    hourOf(new Date(LAST - n * HOUR).toISOString().slice(0, 13), "eu-west-1", [100]),
  );
  const summary = summarize(
    LAST,
    [
      ...fast,
      hourOf("2026-11-03T09", "eu-north-1", [2000]),
      hourOf("2026-11-02T10", "eu-west-1", [60_000]),
    ],
    [],
  );
  // 10 answers in the window, so the p95 is the slowest of them; counting the hour before the
  // window would make it 60 s.
  expect(summary.p95Ms).toBeGreaterThan(2000 * 0.88);
  expect(summary.p95Ms).toBeLessThan(2000 * 1.12);
  expect(summarize(LAST, [], []).p95Ms).toBeNull();
});

test("the minutes add up every day and hour given", () => {
  const summary = summarize(
    LAST,
    [],
    [
      { minutes: 1440, down: 3 },
      { minutes: 60, down: 0 },
      { minutes: 59, down: 1 },
    ],
  );
  expect(summary).toMatchObject({ minutes: 1559, minutesDown: 4 });
});
