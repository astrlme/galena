import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { sqsLambda } from "./lambda-host.ts";
import type { Job } from "./runner.ts";

// The builder Lambda, packaged beside a production install of the status app in `status/`. That
// folder is read-only, and Vite and Astro write caches into its node_modules, so the app's own
// files are copied to /tmp with a node_modules there that links each installed package (copying
// the packages too costs seconds of every cold start).
const packaged = join(import.meta.dirname, "status");
const work = "/tmp/status";
await rm(work, { recursive: true, force: true });
await mkdir(join(work, "node_modules"), { recursive: true });
for (const entry of await readdir(packaged)) {
  if (entry !== "node_modules") {
    await cp(join(packaged, entry), join(work, entry), { recursive: true });
  }
}
for (const name of await readdir(join(packaged, "node_modules"))) {
  await symlink(join(packaged, "node_modules", name), join(work, "node_modules", name));
}
// `astroBuild` finds `status/` in the working directory; Astro keeps its settings under HOME.
process.chdir("/tmp");
process.env.HOME = "/tmp";

/** HTML builds only, without the app key: a message for any other job goes to the dead letters. */
export const handler = sqsLambda(async () => {
  const { pageRebuildHtmlJob } = await import("./jobs/page-rebuild-html.ts");
  return new Map([[pageRebuildHtmlJob.name, pageRebuildHtmlJob as unknown as Job<unknown>]]);
});
