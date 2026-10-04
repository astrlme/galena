import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildExtension } from "@trigger.dev/build/extensions";
import { additionalPackages } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// The CLI evaluates this file before it reads .env, so load it here. A missing file is fine
// when the variable comes from the shell or CI instead.
try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// Every deployment has its own trigger.dev project, so the ref comes from the environment.
const project = process.env.GLN_TRIGGER_PROJECT_REF;
if (!project) {
  throw new Error(
    "GLN_TRIGGER_PROJECT_REF is not set. Copy the project ref (proj_…) from the trigger.dev dashboard into apps/workers/.env.",
  );
}

// page.rebuild-html runs `astro build` on the status app, so the deploy image holds it as
// `status/` next to the workspace packages it imports. Copied with fs.cp rather than
// additionalFiles, which keeps `..` in the destination on Windows and copies outside the image.
const STATUS_APP: Record<string, string[]> = {
  status: ["../status", "package.json", "astro.config.mjs", "tsconfig.json", "src"],
  "packages/config": ["../../packages/config", "package.json", "tsconfig.base.json"],
  "packages/contracts": ["../../packages/contracts", "package.json", "src"],
  "packages/ui": ["../../packages/ui", "package.json", "src"],
};
const statusApp: BuildExtension = {
  name: "status-app",
  async onBuildComplete(context, manifest) {
    // `trigger dev` builds the app where it is.
    if (context.target === "dev") return;
    for (const [to, [from = "", ...entries]] of Object.entries(STATUS_APP)) {
      for (const entry of entries) {
        await cp(resolve(context.workingDir, from, entry), join(manifest.outputPath, to, entry), {
          recursive: true,
          // Tests and the local fixture snapshot stay behind.
          filter: (path) => !/\.test\.ts$|[\\/]src[\\/]data(?:[\\/]|$)/.test(path),
        });
      }
    }
  },
};

export default defineConfig({
  project,
  dirs: ["./src/tasks"],
  maxDuration: 300, // seconds of compute per run; durable waits do not count
  // Reuse a warm process between runs: an outbox dispatch takes ~50 ms, a cold process seconds.
  processKeepAlive: true,
  build: {
    extensions: [
      statusApp,
      additionalPackages({
        packages: ["astro@7.3.5", "@fontsource-variable/atkinson-hyperlegible-next@5.3.0"],
      }),
    ],
  },
});
