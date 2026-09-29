import { expect, test } from "vitest";
import { fillTemplate } from "./templates.ts";

test("fills the values it has, capitalising at the start of a sentence, and leaves the rest", () => {
  expect(fillTemplate("investigating", { component: "API", regions: "3 regions" })).toBe(
    "We're seeing {symptom} on API from 3 regions. We're investigating and will update by {nextUpdate}.",
  );
  expect(fillTemplate("monitoring", { component: "the API", stableMinutes: "15" })).toBe(
    "The API is working normally again. We're watching it for the next 15 minutes.",
  );
  expect(fillTemplate("resolved", {})).toBe(
    "{Component} has worked normally since {time}. {Summary}.",
  );
});

test("a postmortem has no template: people write it themselves", () => {
  expect(fillTemplate("postmortem", { component: "API" })).toBe("");
});
