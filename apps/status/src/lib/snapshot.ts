import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Snapshot, snapshot } from "@galena/contracts";

/**
 * The snapshot this build renders, read from disk at build time. Never `import` it: that puts
 * it in every page's module graph, and every edit would then re-render every page.
 * `page.rebuild-html` writes it; locally `pnpm --filter @galena/status fixture` does.
 */
export function readSnapshot(): Snapshot {
  const path = process.env.GLN_SNAPSHOT_FILE ?? resolve("src/data/snapshot.json");
  return snapshot.parse(JSON.parse(readFileSync(path, "utf8")));
}
