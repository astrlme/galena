import { expect, test } from "vitest";
import { budgetText, monthsBefore, reportCsv, type UptimeReport } from "./report.ts";

const report: UptimeReport = {
  month: "2026-10",
  monitors: [
    {
      id: "01920000-0000-7000-8000-0000000000a1",
      name: 'Checkout, "new"',
      type: "http",
      minutes: 44_640,
      minutesDown: 12,
      incidents: 1,
      p95Ms: 230,
      slaTarget: 99.9,
      budget: { allowedMinutes: 44, leftMinutes: 32 },
    },
    {
      id: "01920000-0000-7000-8000-0000000000a2",
      name: "=HYPERLINK(1)",
      type: "heartbeat",
      minutes: 0,
      minutesDown: 0,
      incidents: 0,
      p95Ms: null,
      slaTarget: null,
      budget: null,
    },
  ],
  components: [
    {
      id: "01920000-0000-7000-8000-000000000011",
      name: "API",
      minutes: 2880,
      minutesDown: 40,
      incidents: 1,
    },
    {
      id: "01920000-0000-7000-8000-000000000012",
      name: "Web",
      minutes: 1000,
      minutesDown: 332,
      incidents: 0,
    },
  ],
};

test("the CSV has a row per monitor and component, quotes what needs it and never starts a formula", () => {
  expect(reportCsv(report).split("\r\n")).toEqual([
    "kind,name,month,minutes_checked,minutes_down,uptime_percent,incidents,p95_ms,sla_target_percent,budget_allowed_minutes,budget_left_minutes",
    'monitor,"Checkout, ""new""",2026-10,44640,12,99.973,1,230,99.9,44,32',
    "monitor,'=HYPERLINK(1),2026-10,0,0,,0,,,,",
    "component,API,2026-10,2880,40,98.611,1,,,,",
    "component,Web,2026-10,1000,332,66.800,0,,,,",
    "",
  ]);
});

test("a budget says what is left, or how far over it went", () => {
  expect(budgetText({ allowedMinutes: 44, leftMinutes: 32 })).toBe("32m left of 44m");
  expect(budgetText({ allowedMinutes: 40, leftMinutes: -125 })).toBe("2h 5m over a 40m budget");
});

test("the month list runs back from this month, newest first", () => {
  const months = monthsBefore(new Date("2026-01-15T00:00:00.000Z"), 3);
  expect(months).toEqual([
    { value: "2026-01", label: "January 2026" },
    { value: "2025-12", label: "December 2025" },
    { value: "2025-11", label: "November 2025" },
  ]);
});
