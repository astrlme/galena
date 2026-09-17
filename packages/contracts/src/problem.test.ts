import { expect, test } from "vitest";
import { problemDetails } from "./problem.ts";

const valid = {
  type: "about:blank",
  title: "Monitor not found",
  status: 404,
  detail: "No monitor has the id you sent. Check the id and try again.",
  code: "monitor_not_found",
};

test("accepts an RFC 9457 problem with our stable code", () => {
  expect(problemDetails.parse(valid)).toEqual(valid);
});

test.each([
  ["a success status", { status: 200 }],
  ["a status outside HTTP", { status: 600 }],
  ["a missing code", { code: undefined }],
  ["a code that is not snake_case", { code: "MonitorNotFound" }],
  ["a missing title", { title: undefined }],
])("rejects %s", (_, change) => {
  expect(problemDetails.safeParse({ ...valid, ...change }).success).toBe(false);
});
