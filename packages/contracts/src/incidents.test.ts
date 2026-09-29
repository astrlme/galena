import { expect, test } from "vitest";
import { incidentCreate, incidentUpdateCreate } from "./incidents.ts";

const api = "01920000-0000-7000-8000-000000000011";

test("a new incident starts investigating with no components unless told otherwise", () => {
  expect(
    incidentCreate.parse({ title: " API errors ", impact: "major", body: "We're looking." }),
  ).toEqual({
    title: "API errors",
    impact: "major",
    status: "investigating",
    body: "We're looking.",
    components: [],
  });
});

test("refuses a component listed twice, and maintenance as an incident's component status", () => {
  const twice = [
    { componentId: api, status: "partial_outage" },
    { componentId: api, status: "major_outage" },
  ];
  expect(
    incidentUpdateCreate.safeParse({ status: "identified", body: "x", components: twice }).success,
  ).toBe(false);
  expect(
    incidentUpdateCreate.safeParse({
      status: "identified",
      body: "x",
      components: [{ componentId: api, status: "under_maintenance" }],
    }).success,
  ).toBe(false);
});

test("an update needs words", () => {
  expect(incidentUpdateCreate.safeParse({ status: "identified", body: "   " }).success).toBe(false);
});
