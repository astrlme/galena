import { expect, test } from "vitest";
import { rebuildPayload } from "./html.ts";

test("refuses a slug that could name a path outside the page's folder", () => {
  expect(rebuildPayload.safeParse({ version: 1, slug: "status" }).success).toBe(true);
  for (const slug of ["", "../status", "a/b", "a\b", ".", "-a"]) {
    expect(rebuildPayload.safeParse({ version: 1, slug }).success).toBe(false);
  }
});
