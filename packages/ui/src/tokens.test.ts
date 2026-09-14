import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { dark, light } from "./tokens.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

// The `--name: #hex` declarations in the first block that follows `selector`.
function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} is missing from tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--(\w+):\s*(#[0-9A-F]{6})/gi)].map((m) => [m[1], m[2]]),
  );
}

test("light tokens in tokens.ts match tokens.css", () => {
  expect(declarations(":root {")).toEqual(light);
});

test("dark tokens in tokens.ts match both dark blocks in tokens.css", () => {
  expect(declarations(':root:not([data-theme="light"])')).toEqual(dark);
  expect(declarations(':root[data-theme="dark"]')).toEqual(dark);
});
