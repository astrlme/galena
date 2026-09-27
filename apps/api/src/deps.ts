import { randomBytes } from "node:crypto";
import type { WorkflowEngine } from "@galena/core";
import { createDb } from "@galena/db";
import { tasks } from "@trigger.dev/sdk";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";
import { env } from "./env.ts";

export function createDeps(): Deps & { close: () => Promise<void> } {
  const { db, close } = createDb({ kind: "postgres", url: env.GLN_DATABASE_URL });
  let secret = env.GLN_AUTH_SECRET;
  if (!secret) {
    // Local only (env.ts refuses this elsewhere): a fresh secret per start signs everyone out.
    console.warn("GLN_AUTH_SECRET is not set; using a random secret until the API restarts.");
    secret = randomBytes(32).toString("hex");
  }
  const github =
    env.GLN_GITHUB_CLIENT_ID && env.GLN_GITHUB_CLIENT_SECRET
      ? { clientId: env.GLN_GITHUB_CLIENT_ID, clientSecret: env.GLN_GITHUB_CLIENT_SECRET }
      : undefined;
  const auth = createAuth({
    db,
    secret,
    baseURL: env.GLN_PUBLIC_URL,
    ...(github ? { github } : {}),
  });
  return { db, auth, engine: env.TRIGGER_SECRET_KEY ? triggerDev : notConfigured, close };
}

const triggerDev: WorkflowEngine = {
  async trigger(task, payload, { idempotencyKey, delay, tags }) {
    await tasks.trigger(task, payload, {
      idempotencyKey,
      ...(delay ? { delay } : {}),
      ...(tags ? { tags } : {}),
    });
  },
};

const notConfigured: WorkflowEngine = {
  async trigger(task) {
    console.warn(`TRIGGER_SECRET_KEY is not set, so ${task} was not triggered.`);
  },
};
