import fc from "fast-check";
import { expect, test } from "vitest";
import { histogramOf, mergeHistograms, quantileOf } from "./histogram.ts";

// The exact nearest-rank quantile: the value at rank ceil(q·n) of the sorted samples.
const exact = (values: number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(q * values.length) - 1)] as number;

const latencies = fc.array(fc.double({ min: 1, max: 60_000, noNaN: true }), {
  minLength: 1,
  maxLength: 500,
});

test("p95 from the histogram stays within 12% of the exact p95", () => {
  fc.assert(
    fc.property(latencies, (values) => {
      const estimate = quantileOf(histogramOf(values), 0.95) as number;
      const truth = exact(values, 0.95);
      expect(Math.abs(estimate - truth) / truth).toBeLessThanOrEqual(0.12);
    }),
    { numRuns: 10_000 },
  );
});

test("a day's histogram from its hours equals the histogram of all its checks", () => {
  fc.assert(
    fc.property(fc.array(latencies, { minLength: 1, maxLength: 24 }), (hours) => {
      const merged = hours.map(histogramOf).reduce(mergeHistograms);
      expect(merged).toEqual(histogramOf(hours.flat()));
    }),
  );
});

test("an hour without checks has no quantile", () => {
  expect(quantileOf(histogramOf([]), 0.95)).toBeNull();
});
