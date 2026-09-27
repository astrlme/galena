// Dependencies for tests. Nothing connects until a query runs, so unit tests need no database.
import type { WorkflowEngine } from "@galena/core";
import { createDb } from "@galena/db";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";

export const TEST_BASE_URL = "http://localhost:8787";

export type Triggered = { task: string; payload: unknown; idempotencyKey: string };

export function testDeps(url = "postgres://unused:unused@localhost:1/unused") {
  const { db, migrate, close } = createDb({ kind: "postgres", url });
  const auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-chars",
    baseURL: TEST_BASE_URL,
  });
  // Records what the API hands to trigger.dev instead of calling it.
  const triggered: Triggered[] = [];
  const engine: WorkflowEngine = {
    async trigger(task, payload, { idempotencyKey }) {
      triggered.push({ task, payload, idempotencyKey });
    },
  };
  return { deps: { db, auth, engine } satisfies Deps, triggered, migrate, close };
}
