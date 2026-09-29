import { componentId, monitorConfig, monitorId, workspaceId } from "@galena/contracts";
import { fixedClock } from "@galena/core";
import {
  createDb,
  type Db,
  listUptimeDays,
  monitorRepository,
  recordMonitorTransition,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rollUpUptime } from "./rollup.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const api = componentId.parse(v7());
const probe = monitorId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
  await db
    .insert(schema.component)
    .values({ id: api, workspaceId: acme, name: "API", position: 0 });
  await monitorRepository(db).save(
    monitorConfig.parse({
      id: probe,
      workspaceId: acme,
      componentId: api,
      name: "API health",
      type: "http",
      http: { url: "https://api.example.com/health" },
      downStatus: "partial_outage",
    }),
  );
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

test("rolls up yesterday and today from recorded transitions, then republishes", async () => {
  const t = { workspaceId: acme, monitorId: probe };
  await recordMonitorTransition(db, {
    ...t,
    from: "unknown",
    to: "up",
    seq: 1,
    at: new Date("2026-09-20T08:00:00Z"),
  });
  await recordMonitorTransition(db, {
    ...t,
    from: "up",
    to: "down",
    seq: 2,
    at: new Date("2026-09-29T09:00:00Z"),
  });
  await recordMonitorTransition(db, {
    ...t,
    from: "down",
    to: "up",
    seq: 3,
    at: new Date("2026-09-29T09:20:00Z"),
  });

  const published: number[] = [];
  const deps = {
    db,
    clock: fixedClock("2026-09-29T12:05:00.000Z"),
    publish: async (version: number) => void published.push(version),
  };
  expect(await rollUpUptime(deps)).toEqual({ days: 2 });
  expect(await rollUpUptime(deps)).toEqual({ days: 2 });
  expect(await listUptimeDays(db, acme, "2026-09-01")).toEqual([
    { componentId: api, date: "2026-09-28", minutes: { operational: 1440 } },
    { componentId: api, date: "2026-09-29", minutes: { operational: 705, partial_outage: 20 } },
  ]);
  expect(published).toHaveLength(2);
});
