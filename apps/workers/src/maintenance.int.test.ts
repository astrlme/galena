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
import { type LifecyclePayload, runMaintenance } from "./maintenance.ts";
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

async function schedule(): Promise<Maintenance> {
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

/**
 * Runs a window's job as the engine does: each wake it asks for runs it again, at that time,
 * until it stops asking. `onWake` changes the window while the job waits.
 */
function waker(onWake?: (date: Date) => Promise<void>, { lateMs = 0 } = {}) {
  let now = at(0);
  const wakes: { at: Date; key: string }[] = [];
  const dispatched: OutboxId[] = [];
  let pending: (LifecyclePayload & { at: string }) | undefined;
  const deps = {
    db,
    clock: { now: () => now },
    wakeAt: async (next: LifecyclePayload & { at: string }, key: string) => {
      pending = next;
      wakes.push({ at: new Date(next.at), key });
    },
    dispatch: async (id: OutboxId) => void dispatched.push(id),
  };
  return {
    wakes,
    dispatched,
    run: async (payload: LifecyclePayload) => {
      let outcome = await runMaintenance(payload, deps);
      for (let wakes = 0; outcome === "waiting"; wakes++) {
        const next = pending;
        if (!next) throw new Error("Waiting with no wake.");
        // A window has two wakes; more means it asked again at the same time and is stuck.
        if (wakes === 2) throw new Error("The window never moved.");
        await onWake?.(new Date(next.at));
        // `lateMs` below zero: the worker's clock runs a moment behind the engine's.
        now = new Date(Date.parse(next.at) + lateMs);
        outcome = await runMaintenance(next, deps);
      }
      return outcome;
    },
  };
}

test("a window starts at startsAt and completes at endsAt, each with its event", async () => {
  const window = await schedule();
  const run = waker();
  const payload = { maintenanceId: window.id, workspaceId: acme, version: 1 };

  expect(await run.run(payload)).toBe("completed");
  expect(run.wakes).toEqual([
    { at: at(10), key: `mnt:${window.id}:1:scheduled` },
    { at: at(40), key: `mnt:${window.id}:1:in_progress` },
  ]);
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

test("a wake that runs while the worker's clock is a moment behind still moves the window", async () => {
  const window = await schedule();
  const run = waker(undefined, { lateMs: -5 });
  const payload = { maintenanceId: window.id, workspaceId: acme, version: 1 };

  expect(await run.run(payload)).toBe("completed");
  expect(run.wakes.map((w) => w.key)).toEqual([
    `mnt:${window.id}:1:scheduled`,
    `mnt:${window.id}:1:in_progress`,
  ]);
});

test("an edit while the job waits supersedes it: the old version stops and moves nothing", async () => {
  const window = await schedule();
  const run = waker(async () => {
    await maintenanceRepository(db).save({ ...window, endsAt: at(60), version: 2 }, 1);
  });
  const payload = { maintenanceId: window.id, workspaceId: acme, version: 1 };

  expect(await run.run(payload)).toBe("superseded");
  expect((await maintenanceRepository(db).findById(acme, window.id))?.status).toBe("scheduled");
  expect(run.dispatched).toEqual([]);
});

test("dispatch starts a run per version, and a cancel starts none", async () => {
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
  const runs = { start: async (_: unknown, key: string) => void started.push(key) };
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
      publish: async () => {},
      confirm: async () => {},
      fanOut: async () => {},
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

  await maintenanceRepository(db).save({ ...window, endsAt: at(50), version: 2 }, 1);
  await dispatch("maintenance.scheduled", 2);
  expect(started).toEqual([`mnt:${window.id}:1`, `mnt:${window.id}:2`]);

  await dispatch("maintenance.cancelled", 2);
  expect(started).toHaveLength(2);
});
