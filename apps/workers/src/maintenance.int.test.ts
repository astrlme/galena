import {
  componentId,
  type MaintenanceEventType,
  type MonitorsFile,
  maintenanceId,
  monitorConfig,
  monitorId,
  type OutboxId,
  workspaceId,
} from "@galena/contracts";
import type { Maintenance } from "@galena/core";
import {
  createDb,
  type Db,
  maintenanceRepository,
  monitorRepository,
  recordChange,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runMaintenance } from "./maintenance.ts";
import { dispatchOutbox } from "./outbox.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const api = componentId.parse(v7());
const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

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
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

async function schedule(): Promise<Omit<Maintenance, "runId">> {
  const window = {
    id: maintenanceId.parse(v7()),
    workspaceId: acme,
    title: "Database upgrade",
    body: "Writes pause.",
    status: "scheduled" as const,
    startsAt: at(10),
    endsAt: at(40),
    version: 1,
    cancelledAt: null,
    componentIds: [api],
  };
  await maintenanceRepository(db).save(window, null);
  return window;
}

/** A clock the run's waits move forward, as trigger.dev's durable waits do in real time. */
function sleeper(onWait?: (date: Date) => Promise<void>) {
  let now = at(0);
  const waits: Date[] = [];
  const dispatched: OutboxId[] = [];
  return {
    waits,
    dispatched,
    deps: {
      db,
      clock: { now: () => now },
      waitUntil: async (date: Date) => {
        waits.push(date);
        await onWait?.(date);
        now = date;
      },
      dispatch: async (id: OutboxId) => void dispatched.push(id),
    },
  };
}

test("a window starts at startsAt and completes at endsAt, each with its event", async () => {
  const window = await schedule();
  const run = sleeper();
  const payload = { maintenanceId: window.id, workspaceId: acme, version: 1 };

  expect(await runMaintenance(payload, run.deps)).toBe("completed");
  expect(run.waits).toEqual([at(10), at(40)]);
  expect((await maintenanceRepository(db).findById(acme, window.id))?.status).toBe("completed");
  const events = (
    await db
      .select({ id: schema.outbox.id, type: schema.outbox.eventType })
      .from(schema.outbox)
      .orderBy(schema.outbox.createdAt)
  ).filter((e) => e.type.startsWith("maintenance."));
  expect(events.map((e) => e.type)).toEqual(["maintenance.started", "maintenance.completed"]);
  expect(run.dispatched).toEqual(events.map((e) => e.id));
});

test("an edit while the run sleeps supersedes it: the old run stops and moves nothing", async () => {
  const window = await schedule();
  const run = sleeper(async () => {
    await maintenanceRepository(db).save({ ...window, endsAt: at(60), version: 2 }, 1);
  });
  const payload = { maintenanceId: window.id, workspaceId: acme, version: 1 };

  expect(await runMaintenance(payload, run.deps)).toBe("superseded");
  expect((await maintenanceRepository(db).findById(acme, window.id))?.status).toBe("scheduled");
  expect(run.dispatched).toEqual([]);
});

test("dispatch starts a run per version, cancels the one it replaces, and a cancel stops it", async () => {
  const window = await schedule();
  const onApi = monitorId.parse(v7());
  await monitorRepository(db).save(
    monitorConfig.parse({
      id: onApi,
      workspaceId: acme,
      componentId: api,
      name: "API",
      type: "http",
      http: { url: "https://api.example.com/health" },
    }),
  );
  const files: MonitorsFile[] = [];
  const started: string[] = [];
  const cancelled: string[] = [];
  const runs = {
    start: async (_: unknown, key: string) => {
      started.push(key);
      return `run-${started.length}`;
    },
    cancel: async (runId: string) => void cancelled.push(runId),
  };
  const dispatch = async (type: MaintenanceEventType, version: number) => {
    const id = await recordChange(db, {
      workspaceId: acme,
      actorUserId: null,
      action: type,
      targetType: "maintenance",
      targetId: window.id,
      event: {
        id: v7(),
        type,
        occurredAt: at(0).toISOString(),
        workspaceId: acme,
        data: { maintenanceId: window.id, version, status: "scheduled" },
      } as never,
    });
    const deps = {
      db,
      clock: { now: () => at(0) },
      writeMonitorsFile: async (file: MonitorsFile) => void files.push(file),
      runs,
    };
    expect(await dispatchOutbox(id, deps)).toBe("dispatched");
  };

  await dispatch("maintenance.scheduled", 1);
  expect(started).toEqual([`mnt:${window.id}:1`]);
  // monitors.json is rewritten so the API's monitor carries the window.
  expect(files.at(-1)?.monitors.find((m) => m.id === onApi)?.maintenance).toContainEqual({
    startsAt: at(10).toISOString(),
    endsAt: at(40).toISOString(),
  });
  expect((await maintenanceRepository(db).findById(acme, window.id))?.runId).toBe("run-1");

  await maintenanceRepository(db).save({ ...window, endsAt: at(50), version: 2 }, 1);
  await dispatch("maintenance.scheduled", 2);
  expect(started).toEqual([`mnt:${window.id}:1`, `mnt:${window.id}:2`]);
  expect(cancelled).toEqual(["run-1"]);

  await dispatch("maintenance.cancelled", 2);
  expect(cancelled).toEqual(["run-1", "run-2"]);
});
