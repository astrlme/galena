// Dependencies for tests. Nothing connects until a query runs, so unit tests need no database.
import { createDb } from "@galena/db";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";

export const TEST_BASE_URL = "http://localhost:8787";

export function testDeps(url = "postgres://unused:unused@localhost:1/unused") {
  const { db, migrate, close } = createDb({ kind: "postgres", url });
  const auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-chars",
    baseURL: TEST_BASE_URL,
  });
  return { deps: { db, auth } satisfies Deps, migrate, close };
}
