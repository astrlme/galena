import { expect, test } from "vitest";
import { reorder } from "./reorder.ts";

test("gives each id its index in the requested order", () => {
  expect(reorder(["a", "b", "c"], ["c", "a", "b"])).toEqual({
    ok: true,
    value: new Map([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]),
  });
});

test.each([
  ["a missing id", ["a", "b"]],
  ["an unknown id", ["a", "b", "z"]],
  ["a repeated id", ["a", "b", "b"]],
  ["an extra id", ["a", "b", "c", "d"]],
])("refuses an order with %s", (_, requested) => {
  const result = reorder(["a", "b", "c"], requested);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("order_mismatch");
});

test("an empty list reorders to nothing", () => {
  expect(reorder([], [])).toEqual({ ok: true, value: new Map() });
});
