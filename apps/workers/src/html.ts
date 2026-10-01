import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { snapshot } from "@galena/contracts";
import { advancePageVersion, type Db, ensurePage } from "@galena/db";
import { z } from "zod";
import type { PageStore, StoredFile } from "./publishing.ts";

export const rebuildPayload = z.object({ version: z.int().min(1) });
export type RebuildPayload = z.infer<typeof rebuildPayload>;

/** Renders the status page for the snapshot in `snapshotFile` into `outDir`. */
export type BuildPage = (snapshotFile: string, outDir: string) => Promise<void>;
export type RebuildDeps = { db: Db; store: PageStore; build: BuildPage };
export type RebuildOutcome = "no_page" | "no_snapshot" | "superseded" | "built";

/**
 * Builds the page's HTML from the newest published `snapshot.json`, which may already be newer
 * than the version that asked for this run; once that HTML is out, older runs stop.
 */
export async function rebuildHtml(
  { version }: RebuildPayload,
  deps: RebuildDeps,
): Promise<{ outcome: RebuildOutcome; built?: number }> {
  const target = await ensurePage(deps.db);
  if (!target) return { outcome: "no_page" };
  if (target.htmlVersion >= version) return { outcome: "superseded" };
  const body = await deps.store.read(target.slug, "snapshot.json");
  if (!body) return { outcome: "no_snapshot" };
  const { snapshotVersion } = snapshot.parse(JSON.parse(body));
  if (target.htmlVersion >= snapshotVersion) return { outcome: "superseded" };

  const work = await mkdtemp(join(tmpdir(), "galena-html-"));
  try {
    const file = join(work, "snapshot.json");
    await writeFile(file, body);
    await deps.build(file, join(work, "dist"));
    await deps.store.write(target.slug, await readTree(join(work, "dist")));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // Runs of this task queue one at a time, so nothing newer went out while this one wrote.
  await advancePageVersion(deps.db, target.id, "html", snapshotVersion);
  return { outcome: "built", built: snapshotVersion };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Every file under `dir`, with paths relative to it. */
export async function readTree(dir: string): Promise<StoredFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const path = join(e.parentPath, e.name);
        return {
          path: relative(dir, path).split(sep).join("/"),
          body: await readFile(path),
          contentType: CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        };
      }),
  );
}

const run = promisify(execFile);

/**
 * `astro build` of the status app. A deployed image carries it as `status/`, with the workspace
 * packages it imports in `packages/`, and this links those where Node looks for them.
 */
export const astroBuild: BuildPage = async (snapshotFile, outDir) => {
  // Deployed (the image root), `trigger dev` (apps/workers), tests (the repository root).
  const dir = ["status", "../status", "apps/status"].find((d) =>
    existsSync(join(d, "astro.config.mjs")),
  );
  if (!dir) throw new Error(`The status app is not beside ${process.cwd()}.`);
  const app = resolve(dir);
  const astro = join(
    dirname(createRequire(join(app, "package.json")).resolve("astro/package.json")),
    "bin",
    "astro.mjs",
  );
  for (const name of ["config", "contracts", "ui"]) {
    const link = join(app, "node_modules", "@galena", name);
    if (existsSync(link)) continue;
    await mkdir(dirname(link), { recursive: true });
    await symlink(resolve(app, "..", "packages", name), link, "junction");
  }
  await run(process.execPath, [astro, "build", "--outDir", outDir], {
    cwd: app,
    env: { ...process.env, GLN_SNAPSHOT_FILE: snapshotFile },
  });
};
