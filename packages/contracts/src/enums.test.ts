import { expect, test } from "vitest";
import { z } from "zod";
import * as enums from "./enums.ts";

const lists = Object.entries(enums).flatMap(([name, values]): [string, readonly string[]][] =>
  Array.isArray(values) ? [[name, values]] : [],
);

test.each(lists)("%s values are snake_case", (_, values) => {
  for (const value of values) expect(value).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
});

test("a parser built from an enum rejects values outside it", () => {
  const componentStatus = z.enum(enums.componentStatuses);
  expect(componentStatus.parse("partial_outage")).toBe("partial_outage");
  expect(componentStatus.safeParse("red").success).toBe(false);
  expect(componentStatus.safeParse("Partial outage").success).toBe(false);
});

// The values the Statuspage v2 API documents: clients of /api/v2 must be able to read ours.
test.each([
  [
    "component statuses",
    enums.componentStatuses,
    ["operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"],
  ],
  [
    "incident statuses",
    enums.incidentStatuses,
    ["investigating", "identified", "monitoring", "resolved", "postmortem"],
  ],
  ["incident impacts", enums.incidentImpacts, ["none", "minor", "major", "critical"]],
  [
    "maintenance statuses",
    enums.maintenanceStatuses,
    ["scheduled", "in_progress", "verifying", "completed"],
  ],
  ["page indicators", enums.pageIndicators, ["none", "minor", "major", "critical"]],
] as const)("keeps every Statuspage %s value", (_, ours, statuspage) => {
  expect(ours).toEqual(expect.arrayContaining([...statuspage]));
});
