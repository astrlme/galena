import { expect, test } from "vitest";
import { every, span } from "./schedule.ts";

test("a span takes the largest whole unit", () => {
  expect([1, 5, 60, 90, 120, 1440, 10_080].map(span)).toEqual([
    "1 minute",
    "5 minutes",
    "1 hour",
    "90 minutes",
    "2 hours",
    "1 day",
    "7 days",
  ]);
});

test("every drops the 1 of a single unit", () => {
  expect([1, 60, 1440, 30].map(every)).toEqual([
    "every minute",
    "every hour",
    "every day",
    "every 30 minutes",
  ]);
});
