import { memberRoles } from "@galena/contracts";
import { expect, test } from "vitest";
import { roleAtLeast } from "./roles.ts";

test.each([
  ["owner", "admin", true],
  ["admin", "admin", true],
  ["editor", "admin", false],
  ["viewer", "editor", false],
  ["viewer", "viewer", true],
] as const)("%s meets %s: %s", (actual, required, expected) => {
  expect(roleAtLeast(actual, required)).toBe(expected);
});

test("every role meets viewer and only owner meets owner", () => {
  for (const role of memberRoles) {
    expect(roleAtLeast(role, "viewer")).toBe(true);
    expect(roleAtLeast(role, "owner")).toBe(role === "owner");
  }
});
