import { expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { rollUp } from "./rollup.ts";
import { monthSpan, pointOf, seriesWindow } from "./series.ts";

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
