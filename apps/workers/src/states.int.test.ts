import { type MonitorId, monitorConfig, monitorId, workspaceId } from "@galena/contracts";
import {
  createDb,
  type Db,
  findMonitorState,
  listMonitorTransitions,
  monitorRepository,
  recordMonitorTransition,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { catchUpStates, type DetectedState } from "./states.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const now = new Date("2026-10-05T12:05:00.000Z");
const minutesAgo = (m: number) => now.getTime() - m * 60_000;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

async function monitor(name: string) {
  const id = monitorId.parse(v7());
  await monitorRepository(db).save(
    monitorConfig.parse({
      id,
      workspaceId: acme,
      componentId: null,
      name,
      type: "http",
      http: { url: `https://${name}.example.com/` },
    }),
  );
  return id;
}

test("a monitor whose transition never reached Postgres catches up once; recent and current ones stay", async () => {
  const lost = await monitor("lost");
  const inFlight = await monitor("in-flight");
  const current = await monitor("current");
  const unseen = await monitor("unseen");
  await recordMonitorTransition(db, {
    workspaceId: acme,
    monitorId: current,
    from: "unknown",
    to: "up",
    seq: 1,
    at: new Date(minutesAgo(90)),
  });
  const detected = new Map<MonitorId, DetectedState>([
    [lost, { state: "up", transitionSeq: 1, enteredAt: minutesAgo(60) }],
    [inFlight, { state: "down", transitionSeq: 1, enteredAt: minutesAgo(1) }],
    [current, { state: "up", transitionSeq: 1, enteredAt: minutesAgo(90) }],
  ]);
  const deps = { db, clock: { now: () => now }, readStates: async () => detected };

  expect(await catchUpStates(deps)).toEqual({ caughtUp: 1 });
  expect(await findMonitorState(db, acme, lost)).toBe("up");
  expect(await findMonitorState(db, acme, inFlight)).toBe("unknown");
  expect(await findMonitorState(db, acme, unseen)).toBe("unknown");
  const history = await listMonitorTransitions(db, acme, new Date(minutesAgo(120)));
  expect(history.filter((t) => t.monitorId === lost)).toEqual([
    { monitorId: lost, state: "up", at: new Date(minutesAgo(60)) },
  ]);

  // The next hour finds nothing behind.
  expect(await catchUpStates(deps)).toEqual({ caughtUp: 0 });
});
