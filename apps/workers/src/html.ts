import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { snapshot } from "@galena/contracts";
import { INTERNAL_SLUG } from "@galena/core";
import { z } from "zod";
import type { PageStore, StoredFile } from "./publishing.ts";

export const rebuildPayload = z.object({ version: z.int().min(1), slug: z.string().min(1) });
export type RebuildPayload = z.infer<typeof rebuildPayload>;

/** Renders the status page for the snapshot in `snapshotFile` into `outDir`, served at `base`. */
export type BuildPage = (snapshotFile: string, outDir: string, base: string) => Promise<void>;
export type RebuildDeps = { store: PageStore; build: BuildPage };
export type RebuildOutcome = "no_snapshot" | "superseded" | "built";

/**
 * Builds the page's HTML from the newest published `snapshot.json`, which may already be newer
 * than the version that asked for this run; once that HTML is out, older runs stop. The page's
 * own `index.html` says which snapshot it was built from, so the build needs no database.
 */
export async function rebuildHtml(
  { version, slug }: RebuildPayload,
  deps: RebuildDeps,
): Promise<{ outcome: RebuildOutcome; built?: number }> {
  const built = builtFrom(await deps.store.read(slug, "index.html"));
  if (built >= version) return { outcome: "superseded" };
  const body = await deps.store.read(slug, "snapshot.json");
  if (!body) return { outcome: "no_snapshot" };
  const { snapshotVersion } = snapshot.parse(JSON.parse(body));
  if (built >= snapshotVersion) return { outcome: "superseded" };

  const work = await mkdtemp(join(tmpdir(), "galena-html-"));
  const build = async (target: string, text: string, base: string) => {
    const file = join(work, `${target}.json`);
    await writeFile(file, text);
    await deps.build(file, join(work, target), base);
    const files = await readTree(join(work, target));
    // index.html last: it marks the build as out, so a retry after a failed upload builds again.
    await deps.store.write(
      target,
      files.filter((f) => f.path !== "index.html"),
    );
    await deps.store.write(
      target,
      files.filter((f) => f.path === "index.html"),
    );
  };
  try {
    await build(slug, body, "/");
    // The internal view, written by the same publish, is served under /internal/ on the dashboard.
    // A failure here waits for the next publish rather than building the page again.
    const internal = await deps.store.read(INTERNAL_SLUG, "snapshot.json");
    if (internal) {
      await build(INTERNAL_SLUG, internal, `/${INTERNAL_SLUG}/`).catch((error: unknown) => {
        console.warn("page.rebuild-html internal view not built", { error: String(error) });
      });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { outcome: "built", built: snapshotVersion };
}

/** The snapshot version an `index.html` was built from; 0 for none. */
function builtFrom(html: string | undefined): number {
  return Number(html?.match(/data-snapshot-version="(\d+)"/)?.[1] ?? 0);
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

// What Node and Astro need to run, and nothing else: the worker's AWS, database and app keys
// stay out of the build, and Astro's telemetry stays off.
const BUILD_ENV = [
  "PATH",
  "HOME",
  "ESBUILD_BINARY_PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "USERPROFILE",
  "LOCALAPPDATA",
];
const buildEnv = () =>
  Object.fromEntries(
    BUILD_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
  );

/** `astro build` of the status app, wherever it sits beside the process. */
export const astroBuild: BuildPage = async (snapshotFile, outDir, base) => {
  // The builder Lambda (from /tmp), apps/workers, tests (the repository root).
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
  // Astro builds an output outside the app in the app's own folder, then moves the files there
  // with rename(), which fails across filesystems (EXDEV), as between a CI checkout and /tmp. So
  // it builds inside the app's ignored dist/ and the result is copied out.
  await mkdir(join(app, "dist"), { recursive: true });
  const local = await mkdtemp(join(app, "dist", "build-"));
  try {
    await run(process.execPath, [astro, "build", "--outDir", local, "--base", base], {
      cwd: app,
      env: { ...buildEnv(), ASTRO_TELEMETRY_DISABLED: "1", GLN_SNAPSHOT_FILE: snapshotFile },
    });
    await cp(local, outDir, { recursive: true });
  } finally {
    await rm(local, { recursive: true, force: true });
  }
};
