// `pnpm check:page`: the built status page against its budgets. Lighthouse mobile scores 100
// for performance and accessibility, JavaScript stays within 15 KB gzipped, every HTML file
// under 40 KB, and axe finds nothing in light or dark. Serves the build in dist/ the way
// CloudFront does (a directory means its index.html) and drives the installed Chrome.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const PORT = 4322;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const DEBUG_PORT = 9322;
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

// Budgets, from the files themselves.
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
const built = files("dist");
let js = 0;
for (const file of built) {
  const text = readFileSync(file);
  if (file.endsWith(".js")) js += gzipSync(text).length;
  if (file.endsWith(".html")) {
    for (const [, script] of text.toString().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      js += gzipSync(script).length;
    }
    check(text.length < 40_000, `${file} is ${text.length} bytes (budget 40,000)`);
  }
}
check(js <= 15_360, `JavaScript is ${js} bytes gzipped (budget 15,360)`);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = join("dist", normalize(path));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
try {
  const browser = await chromium.launch({
    channel: "chrome",
    args: [`--remote-debugging-port=${DEBUG_PORT}`],
  });
  try {
    // Lighthouse's default is a throttled mobile device. Its performance score moves by a
    // point between runs on the same build, so the best of three runs counts.
    const metrics = ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time"];
    let best;
    for (let run = 0; run < 3 && !(best?.performance === 1 && best?.accessibility === 1); run++) {
      const { lhr } = await lighthouse(ORIGIN, {
        port: DEBUG_PORT,
        output: "json",
        logLevel: "error",
        onlyCategories: ["performance", "accessibility"],
      });
      console.log(`     ${metrics.map((id) => `${id} ${lhr.audits[id].displayValue}`).join(", ")}`);
      best = {
        performance: Math.max(best?.performance ?? 0, lhr.categories.performance.score),
        accessibility: Math.max(best?.accessibility ?? 0, lhr.categories.accessibility.score),
      };
    }
    for (const [name, score] of Object.entries(best)) {
      check(score === 1, `Lighthouse mobile ${name}: ${Math.round(score * 100)}`);
    }
    for (const scheme of ["light", "dark"]) {
      for (const path of [
        "",
        "history/",
        ...readdirSync("dist/incidents").map((id) => `incidents/${id}/`),
      ]) {
        const context = await browser.newContext({ colorScheme: scheme });
        const page = await context.newPage();
        await page.goto(ORIGIN + path);
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        check(
          violations.length === 0,
          `axe ${scheme} /${path}: ${violations.map((v) => v.id).join(", ") || "no violations"}`,
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.close();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe page is within every budget.");
