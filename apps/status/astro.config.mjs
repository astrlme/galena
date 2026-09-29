import { dark, light } from "@galena/ui/tokens";
import { defineConfig } from "astro/config";

// The colour tokens as CSS variables, generated from tokens.ts (kept in step with tokens.css by
// its test), so the page has no colour literals of its own and CSP hashes it like any stylesheet.
const vars = (tokens) =>
  Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
const tokensCss = `:root{${vars(light)}color-scheme:light dark}@media (prefers-color-scheme: dark){:root{${vars(dark)}}}`;
const TOKENS = "virtual:galena/tokens.css";

export default defineConfig({
  output: "static",
  trailingSlash: "always",
  // page.rebuild-html restores and saves this between builds (incremental builds).
  cacheDir: process.env.GLN_ASTRO_CACHE_DIR ?? "./node_modules/.astro",
  experimental: { incrementalBuild: true },
  security: { csp: true },
  // No code blocks on the page; Shiki's inline styles would fight the CSP.
  markdown: { syntaxHighlight: false },
  vite: {
    plugins: [
      {
        name: "galena-tokens",
        resolveId: (id) => (id === TOKENS ? `\0${TOKENS}` : null),
        load: (id) => (id === `\0${TOKENS}` ? tokensCss : null),
      },
    ],
  },
});
