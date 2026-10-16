import { expect, test } from "vitest";
import { cronPatterns, schedulerCron } from "./crons.ts";
import { laneOf } from "./lanes.ts";

test.each([
  ["5 */6 * * *", "cron(5 0/6 * * ? *)"],
  ["35 * * * *", "cron(35 * * * ? *)"],
  ["0 3 * * *", "cron(0 3 * * ? *)"],
])("%s runs on Scheduler as %s", (pattern, expression) => {
  expect(schedulerCron(pattern)).toBe(expression);
});

test("a pattern naming days, months or weekdays is refused, as nothing here uses one", () => {
  expect(() => schedulerCron("0 3 1 * *")).toThrow(/must be \*/);
  expect(() => schedulerCron("0 3 * * 1")).toThrow(/must be \*/);
});

test("every scheduled job has a fixed lane, so a recurring schedule names one group", () => {
  for (const job of Object.keys(cronPatterns)) {
    expect(laneOf(job, "cron:a")).toBe(laneOf(job, "cron:b"));
  }
  expect(laneOf("page.heartbeat", "cron:a")).toBe(laneOf("page.publish", "pub:1"));
});
