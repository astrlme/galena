// `pnpm --filter @galena/web check:links`: every same-site link in the built site (out/) must
// reach a file, the way CloudFront serves it (a directory means its index.html), and every
// `#fragment` must name an element on the target page. Run after `next build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../out/", import.meta.url));

const pages = readdirSync(OUT, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".html"))
  .map((file) => file.replaceAll("\\", "/"));

/** The file CloudFront would answer `path` with, or undefined. */
function resolve(path) {
  const clean = decodeURIComponent(path).replace(/^\/+/, "");
  return [join(clean, "index.html"), clean]
    .map((candidate) => join(OUT, candidate))
    .find((file) => existsSync(file) && statSync(file).isFile());
}

const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
};

const broken = [];
for (const page of pages) {
  const file = join(OUT, page);
  const html = readFileSync(file, "utf8");
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (/^[a-z]+:|^\/\//i.test(href)) continue; // another site, mailto: and the like
    if (href.startsWith("/_next/")) continue;
    const [path, fragment] = href.split("#", 2);
    const target = path === "" ? file : path.startsWith("/") ? resolve(path) : undefined;
    if (target === undefined) {
      broken.push(`${page}: ${href} (no such page)`);
    } else if (fragment && !idsOf(target).has(decodeURIComponent(fragment))) {
      broken.push(`${page}: ${href} (no #${fragment} there)`);
    }
  }
}

for (const line of [...new Set(broken)].sort()) console.log(`FAIL ${line}`);
console.log(`${pages.length} pages checked, ${new Set(broken).size} broken links.`);
if (broken.length > 0) process.exitCode = 1;
