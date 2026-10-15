import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

// The builder Lambda: the jobs handler, packaged beside a production install of the status app
// in `status/`. That folder is read-only, and Vite and Astro write caches into its node_modules,
// so the app's own files are copied to /tmp with a node_modules there that links each installed
// package (copying the packages too costs seconds of every cold start).
const packaged = join(import.meta.dirname, "status");
const work = "/tmp/status";
await rm(work, { recursive: true, force: true });
await mkdir(join(work, "node_modules"), { recursive: true });
for (const entry of await readdir(packaged)) {
  if (entry !== "node_modules")
    await cp(join(packaged, entry), join(work, entry), { recursive: true });
}
for (const name of await readdir(join(packaged, "node_modules"))) {
  await symlink(join(packaged, "node_modules", name), join(work, "node_modules", name));
}
// `astroBuild` finds `status/` in the working directory; Astro keeps its settings under HOME.
process.chdir("/tmp");
process.env.HOME = "/tmp";

export { handler } from "./lambda.ts";
