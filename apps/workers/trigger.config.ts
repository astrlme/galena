import { defineConfig } from "@trigger.dev/sdk";

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
});
