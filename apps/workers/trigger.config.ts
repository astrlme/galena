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

export default defineConfig({
  project,
  dirs: ["./src/tasks"],
  maxDuration: 300, // seconds of compute per run; durable waits do not count
  // Reuse a warm process between runs: an outbox dispatch takes ~50 ms, a cold process seconds.
  processKeepAlive: true,
});
