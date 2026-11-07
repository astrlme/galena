// Dependencies for tests. Nothing connects until a query runs, so unit tests need no database.
import type { MonitorDay, MonitorId, RecentCheck, StoredPing } from "@galena/contracts";
import type { MinuteCounts, WorkflowEngine } from "@galena/core";
import { createDb } from "@galena/db";
import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import type { Deps } from "./app.ts";
import { createAuth } from "./auth.ts";
import type { MonitorReading, Telemetry } from "./telemetry.ts";

export const TEST_BASE_URL = "http://localhost:8787";

export type Triggered = { task: string; payload: unknown; idempotencyKey: string; at?: Date };

export function testDeps(url = "postgres://unused:unused@localhost:1/unused") {
  const { db, migrate, close } = createDb({ kind: "postgres", url });
  const auth = createAuth({
    db,
    secret: "test-secret-that-is-at-least-32-chars",
    baseURL: TEST_BASE_URL,
  });
  // Records the jobs the API starts instead of starting them.
  const triggered: Triggered[] = [];
  const engine: WorkflowEngine = {
    async trigger(task, payload, { idempotencyKey, at }) {
      triggered.push({ task, payload, idempotencyKey, ...(at ? { at } : {}) });
    },
  };
  // Telemetry the test sets directly instead of DynamoDB.
  const readings = new Map<MonitorId, MonitorReading>();
  // Each monitor's chart, days and last hour, and a month's minutes by `<monitorId> <YYYY-MM>`.
  const charts = new Map<MonitorId, Awaited<ReturnType<Telemetry["series"]>>>();
  const uptimes = new Map<MonitorId, MinuteCounts>();
  const days = new Map<MonitorId, MonitorDay[]>();
  const checks = new Map<MonitorId, RecentCheck[]>();
  const months = new Map<string, MinuteCounts>();
  // Check-ins as DynamoDB keeps them: an older URL never overwrites a newer one's.
  const pings = new Map<MonitorId, StoredPing>();
  const checkInTimes = new Map<MonitorId, string[]>();
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
    async series(id) {
      return charts.get(id) ?? { points: [], totals: [] };
    },
    async uptime(id) {
      return uptimes.get(id) ?? { minutes: 0, down: 0 };
    },
    async days(id) {
      return days.get(id) ?? [];
    },
    async checks(id, since) {
      return (checks.get(id) ?? []).filter((r) => r.scheduledAt >= since);
    },
    async minutes(id, month, _today) {
      return months.get(`${id} ${month}`) ?? { minutes: 0, down: 0 };
    },
    async checkIn(id, issuedAt, at) {
      if ((pings.get(id)?.issuedAt ?? 0) > issuedAt.getTime()) return false;
      pings.set(id, { at: at.getTime(), issuedAt: issuedAt.getTime() });
      checkInTimes.set(id, [at.toISOString(), ...(checkInTimes.get(id) ?? [])]);
      return true;
    },
    async checkIns(id, count) {
      return (checkInTimes.get(id) ?? []).slice(0, count);
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
      publicUrl: TEST_BASE_URL,
      setup: "open",
      subscriptions: true,
    } satisfies Deps,
    triggered,
    readings,
    charts,
    uptimes,
    days,
    checks,
    months,
    pings,
    migrate,
    close,
  };
}
