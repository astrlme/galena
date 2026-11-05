import { expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { rollUp } from "./rollup.ts";
import {
  monthSpan,
  ninetyDays,
  pointOf,
  seriesOf,
  seriesWindow,
  totalOf,
  windowSpan,
} from "./series.ts";

test("a point says the median, p95 and slowest answer, and the mean of each phase", () => {
  const { regions } = rollUp(
    [
      {
        region: "eu-west-1",
        scheduledAt: "2026-11-02T13:00:00.000Z",
        status: "up",
        latencyMs: 100,
        phases: { dns: 10, connect: 20, tls: null, ttfb: 70, total: 100 },
      },
      {
        region: "eu-west-1",
        scheduledAt: "2026-11-02T13:01:00.000Z",
        status: "up",
        latencyMs: 900,
        phases: { dns: 30, connect: 40, tls: null, ttfb: 830, total: 900 },
      },
      {
        region: "eu-west-1",
        scheduledAt: "2026-11-02T13:02:00.000Z",
        status: "down",
        latencyMs: null,
        phases: null,
      },
    ],
    2,
  );
  const point = pointOf(regions.get("eu-west-1") ?? expect.fail("no rollup"));
  expect(point).toMatchObject({ checks: 3, down: 1, maxMs: 900 });
  expect(point.phases).toEqual({ dns: 20, connect: 30, tls: null, ttfb: 450 });
  // Within a bucket's 12% of 100 and 900 ms.
  expect(point.medianMs).toBeGreaterThan(88);
  expect(point.medianMs).toBeLessThan(112);
  expect(point.p95Ms).toBeGreaterThan(792);
  expect(point.p95Ms).toBeLessThan(1008);
});

test("each range reads the finest rollup that keeps it small, and only whole spans before now", () => {
  const now = fixedClock("2026-11-02T13:20:30.000Z").now();
  expect(seriesWindow("24h", now)).toEqual({
    source: "hour",
    from: "2026-11-01T13",
    to: "2026-11-02T12",
  });
  expect(seriesWindow("7d", now)).toEqual({
    source: "hour",
    from: "2026-10-26T13",
    to: "2026-11-02T12",
  });
  expect(seriesWindow("30d", now)).toEqual({ source: "day", from: "2026-10-03", to: "2026-11-01" });
  expect(seriesWindow("90d", now)).toEqual({ source: "day", from: "2026-08-04", to: "2026-11-01" });
});

test("a month runs from its first midnight to the next month's, across a year's end", () => {
  expect(monthSpan("2026-12")).toEqual({
    from: new Date("2026-12-01T00:00:00.000Z"),
    to: new Date("2027-01-01T00:00:00.000Z"),
    days: { from: "2026-12-01", to: "2026-12-31" },
  });
  expect(monthSpan("2028-02").days).toEqual({ from: "2028-02-01", to: "2028-02-29" });
});

test("a range's total p95 comes from all its answers, not from its points' p95s", () => {
  const hour = (at: string, latencies: number[]) =>
    rollUp(
      latencies.map((ms, n) => ({
        region: "eu-west-1",
        scheduledAt: `${at}:${String(n).padStart(2, "0")}:00.000Z`,
        status: "up" as const,
        latencyMs: ms,
        phases: null,
      })),
      2,
    ).regions.get("eu-west-1") ?? expect.fail("no rollup");
  // 19 quick answers in one hour and one slow one in the next: each hour's p95 is its own, but
  // the range's 95th of 20 answers is a quick one.
  const quick = hour(
    "2026-11-02T13",
    Array.from({ length: 19 }, () => 100),
  );
  const slow = hour("2026-11-02T14", [2000]);
  expect(pointOf(slow).p95Ms).toBeGreaterThan(1760);
  const total = totalOf([quick, slow]) ?? expect.fail("no total");
  expect(total).toMatchObject({ checks: 20, down: 0 });
  expect(total.p95Ms).toBeGreaterThan(88);
  expect(total.p95Ms).toBeLessThan(112);
  expect(total.maxMs).toBe(2000);
  expect(totalOf([])).toBeNull();
});

test("a window spans from its first span's start to its last span's end", () => {
  expect(windowSpan({ source: "hour", from: "2026-11-01T13", to: "2026-11-02T12" })).toEqual({
    from: new Date("2026-11-01T13:00:00.000Z"),
    to: new Date("2026-11-02T13:00:00.000Z"),
  });
  expect(windowSpan({ source: "day", from: "2026-10-03", to: "2026-11-01" })).toEqual({
    from: new Date("2026-10-03T00:00:00.000Z"),
    to: new Date("2026-11-02T00:00:00.000Z"),
  });
});

test("a series is its points oldest first, then each region's total and all regions' together", () => {
  const one = (region: string, ms: number) =>
    rollUp(
      [
        {
          region,
          scheduledAt: "2026-11-02T13:00:00.000Z",
          status: "up",
          latencyMs: ms,
          phases: null,
        },
      ],
      2,
    ).regions.get(region) ?? expect.fail("no rollup");
  const { points, totals } = seriesOf([
    { at: "2026-11-02T14", region: "eu-west-3", rollup: one("eu-west-3", 300) },
    { at: "2026-11-02T13", region: "eu-west-1", rollup: one("eu-west-1", 100) },
    { at: "2026-11-02T14", region: "eu-west-1", rollup: one("eu-west-1", 200) },
  ]);
  expect(points.map((p) => `${p.at} ${p.region}`)).toEqual([
    "2026-11-02T13 eu-west-1",
    "2026-11-02T14 eu-west-1",
    "2026-11-02T14 eu-west-3",
  ]);
  expect(totals.map((t) => [t.region, t.checks, t.maxMs])).toEqual([
    ["eu-west-1", 2, 200],
    ["eu-west-3", 1, 300],
    [null, 3, 300],
  ]);
  expect(seriesOf([])).toEqual({ points: [], totals: [] });
});

test("the 90 days end today; a day without its rollup counts its hours, and none is no data", () => {
  const days = ninetyDays(
    "2026-11-03",
    new Map([["2026-08-06", { minutes: 1440, down: 4 }]]),
    // Just after midnight: yesterday's day rollup isn't written yet, its hours are.
    new Map([
      ["2026-11-02", { minutes: 1440, down: 2 }],
      ["2026-11-03", { minutes: 5, down: 0 }],
    ]),
  );
  expect(days).toHaveLength(90);
  expect(days[0]).toEqual({ date: "2026-08-06", minutes: 1440, minutesDown: 4 });
  expect(days[1]).toEqual({ date: "2026-08-07", minutes: 0, minutesDown: 0 });
  expect(days.slice(-2)).toEqual([
    { date: "2026-11-02", minutes: 1440, minutesDown: 2 },
    { date: "2026-11-03", minutes: 5, minutesDown: 0 },
  ]);
});
