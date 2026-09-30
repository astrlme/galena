// Dependencies for tests. Nothing connects until a query runs, so unit tests need no database.
import type { MonitorId } from "@galena/contracts";
import type { WorkflowEngine } from "@galena/core";
import { createDb } from "@galena/db";
import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";
import type { MonitorReading, Telemetry } from "./telemetry.ts";

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
  // Telemetry the test sets directly instead of DynamoDB.
  const readings = new Map<MonitorId, MonitorReading>();
  const telemetry: Telemetry = {
    regions: ["eu-west-1", "eu-west-3", "eu-north-1"],
    async read(ids) {
      return new Map(
        ids.flatMap((id) => {
          const reading = readings.get(id);
          return reading ? [[id, reading] as const] : [];
        }),
      );
    },
  };
  return {
    deps: {
      db,
      auth,
      engine,
      telemetry,
      targets: guard,
      keys: appKeys(LOCAL_APP_KEY),
    } satisfies Deps,
    triggered,
    readings,
    migrate,
    close,
  };
}
