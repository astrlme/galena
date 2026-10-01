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

// WCAG 2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test.each([
  ["light", light],
  ["dark", dark],
] as const)("in %s mode, text and state colours read at 4.5:1 on paper and surface", (_, t) => {
  for (const name of [
    "ink",
    "graphite",
    "slate",
    "operational",
    "degraded",
    "partial",
    "major",
    "maintenance",
  ] as const) {
    for (const back of [t.paper, t.surface]) {
      expect(contrast(t[name], back), `${name} on ${back}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("the filled major-outage badge reads at 4.5:1 in both modes", () => {
  expect(contrast(light.paper, light.major)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.paper, dark.major)).toBeGreaterThanOrEqual(4.5);
});
