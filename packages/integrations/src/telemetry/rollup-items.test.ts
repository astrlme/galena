import { rollUp } from "@galena/core";
import { expect, test } from "vitest";
import { rawCheckOf, regionHourKey, regionRollupOf, spanKeys } from "./rollup-items.ts";

test("a region's hour reads back as it was written, with its hour and region from the key", () => {
  const check = rawCheckOf({
    pk: "MON#m1",
    sk: "R#2026-11-02T13:04:00.000Z#eu-west-1",
    status: "up",
    latencyMs: 120,
    phases: { dns: 5, connect: 9, tls: 20, ttfb: 110, total: 120 },
  });
  expect(check).toEqual({
    region: "eu-west-1",
    scheduledAt: "2026-11-02T13:04:00.000Z",
    status: "up",
    latencyMs: 120,
    phases: { dns: 5, connect: 9, tls: 20, ttfb: 110, total: 120 },
  });
  const rollup = rollUp([check], 2).regions.get("eu-west-1") ?? expect.fail("no rollup");
  const item = { sk: regionHourKey("2026-11-02T13", "eu-west-1"), ...rollup };
  expect(regionRollupOf(item)).toEqual({ at: "2026-11-02T13", region: "eu-west-1", rollup });
});

test("a span's keys take in every region of its last hour and nothing after it", () => {
  const { from, to } = spanKeys("H", "2026-11-01T00", "2026-11-01T23");
  const inside = regionHourKey("2026-11-01T23", "eu-west-3");
  const after = regionHourKey("2026-11-02T00", "eu-west-1");
  expect(inside > from && inside < to).toBe(true);
  expect(after > to).toBe(true);
});

test("an item that isn't what the rollup wrote is refused, not trusted", () => {
  expect(() =>
    rawCheckOf({ sk: "R#2026-11-02T13:04:00.000Z#eu-west-1", status: "sideways" }),
  ).toThrow();
});
