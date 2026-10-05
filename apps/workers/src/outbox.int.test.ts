import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventId,
  type MonitorsFile,
  monitorConfig,
  monitorId,
  monitorsFile,
  type OutboxId,
  outboxId,
  subscriberId,
  type WorkspaceId,
  workspaceId,
} from "@galena/contracts";
import { fixedClock } from "@galena/core";
import {
  createDb,
  type Db,
  findDelivery,
  findOutboxRow,
  monitorRepository,
  recordChange,
  saveSubscriber,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dispatchOutbox, localMonitorsFile, sweepOutbox } from "./outbox.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const clock = fixedClock("2026-09-28T10:00:00.000Z");

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

const saveMonitor = (name: string, enabled: boolean) =>
  monitorRepository(db).save(
    monitorConfig.parse({
      id: monitorId.parse(v7()),
      workspaceId: acme,
      componentId: null,
      name,
      type: "http",
      http: { url: `https://${name.toLowerCase()}.example.com/health` },
      enabled,
    }),
  );

const outboxRow = (type: string, ws: WorkspaceId = acme) =>
  recordChange(db, {
    workspaceId: ws,
    actorUserId: null,
    action: `${type.replace(".changed", "")}.updated`,
    targetType: type.replace(".changed", ""),
    targetId: null,
    event: {
      id: v7(),
      type,
      occurredAt: clock.now().toISOString(),
      workspaceId: ws,
      data: { action: "updated", ids: [] },
    } as never,
  });

/** Monitor changes never start lifecycle runs. */
const noRuns = {
  start: async () => {
    throw new Error("No lifecycle run expected.");
  },
  cancel: async () => {},
};

/** The versions each dispatch asked `page.publish` for. */
const published: number[] = [];
const publish = async (version: number) => void published.push(version);
const confirmations: { eventId: string; subscriberId: string }[] = [];
const confirm = async (request: { eventId: string; subscriberId: string }) =>
  void confirmations.push(request);
const fanOut = async () => {};

/** Collects what would be written instead of writing it. */
function collector() {
  const files: MonitorsFile[] = [];
  return { files, writeMonitorsFile: async (file: MonitorsFile) => void files.push(file) };
}

test("a monitor change rewrites monitors.json with the enabled monitors, then marks the row", async () => {
  await saveMonitor("Api", true);
  await saveMonitor("Paused", false);
  const id = await outboxRow("monitor.changed");
  const { files, writeMonitorsFile } = collector();

  expect(
    await dispatchOutbox(id, {
      db,
      clock,
      writeMonitorsFile,
      runs: noRuns,
      publish,
      confirm,
      fanOut,
    }),
  ).toBe("dispatched");
  expect(files).toHaveLength(1);
  expect(files[0]?.monitors.map((m) => m.http.url)).toEqual(["https://api.example.com/health"]);
  const row = await findOutboxRow(db, id);
  expect(row?.dispatchedAt?.toISOString()).toBe("2026-09-28T10:00:00.000Z");

  // A second run for the same row, e.g. the backstop, finds it done and writes nothing.
  expect(
    await dispatchOutbox(id, {
      db,
      clock,
      writeMonitorsFile,
      runs: noRuns,
      publish,
      confirm,
      fanOut,
    }),
  ).toBe("already_dispatched");
  expect(files).toHaveLength(1);
});

test("a row whose transaction rolled back is skipped", async () => {
  const { files, writeMonitorsFile } = collector();
  const missing = outboxId.parse(v7());
  expect(
    await dispatchOutbox(missing, {
      db,
      clock,
      writeMonitorsFile,
      runs: noRuns,
      publish,
      confirm,
      fanOut,
    }),
  ).toBe("rolled_back");
  expect(files).toHaveLength(0);
});

test("a page event republishes the page with a newer version each time", async () => {
  published.length = 0;
  const { files, writeMonitorsFile } = collector();
  for (const type of ["component.changed", "component_group.changed"]) {
    const id = await outboxRow(type);
    expect(
      await dispatchOutbox(id, {
        db,
        clock,
        writeMonitorsFile,
        runs: noRuns,
        publish,
        confirm,
        fanOut,
      }),
    ).toBe("dispatched");
  }
  expect(files).toHaveLength(0);
  expect(published).toHaveLength(2);
  expect(published[1]).toBeGreaterThan(published[0] ?? Number.POSITIVE_INFINITY);
});

test("other event types are only marked dispatched", async () => {
  published.length = 0;
  const id = await outboxRow("subscriber.confirmed");
  const { files, writeMonitorsFile } = collector();
  expect(
    await dispatchOutbox(id, {
      db,
      clock,
      writeMonitorsFile,
      runs: noRuns,
      publish,
      confirm,
      fanOut,
    }),
  ).toBe("dispatched");
  expect(files).toHaveLength(0);
  expect(published).toEqual([]);
});

test("the local writer replaces monitors.json with a file the probes can parse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "galena-config-"));
  try {
    const write = localMonitorsFile(dir);
    const file: MonitorsFile = { version: 1, generatedAt: clock.now().toISOString(), monitors: [] };
    await write(file);
    await write({ ...file, generatedAt: "2026-09-28T10:05:00.000Z" });
    const written = monitorsFile.parse(
      JSON.parse(await readFile(join(dir, "monitors.json"), "utf8")),
    );
    expect(written.generatedAt).toBe("2026-09-28T10:05:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscription request records its delivery and sends its confirmation", async () => {
  const subscriber = subscriberId.parse(v7());
  const event = eventId.parse(v7());
  await saveSubscriber(db, {
    id: subscriber,
    workspaceId: acme,
    email: "ada@example.com",
    state: "pending_confirmation",
    componentIds: [],
    confirmSentAt: clock.now(),
    ipHash: null,
  });
  const id = await recordChange(db, {
    workspaceId: acme,
    actorUserId: null,
    action: "subscriber.requested",
    targetType: "subscriber",
    targetId: subscriber,
    event: {
      id: event,
      type: "subscriber.requested",
      occurredAt: clock.now().toISOString(),
      workspaceId: acme,
      data: { subscriberId: subscriber },
    } as never,
  });
  const { writeMonitorsFile } = collector();
  expect(
    await dispatchOutbox(id, {
      db,
      clock,
      writeMonitorsFile,
      runs: noRuns,
      publish,
      confirm,
      fanOut,
    }),
  ).toBe("dispatched");
  expect(confirmations).toEqual([{ eventId: event, subscriberId: subscriber }]);
  expect(await findDelivery(db, event, { subscriberId: subscriber })).toMatchObject({
    status: "pending",
  });
});

test("the sweep hands rows pending for over five minutes back to the dispatcher, oldest first", async () => {
  const now = new Date();
  const row = async (minutesAgo: number, dispatched = false) => {
    const id = outboxId.parse(v7());
    const at = new Date(now.getTime() - minutesAgo * 60_000);
    await db.insert(schema.outbox).values({
      id,
      workspaceId: acme,
      eventType: "component.changed",
      payload: {},
      createdAt: at,
      dispatchedAt: dispatched ? at : null,
    });
    return id;
  };
  const older = await row(70);
  const old = await row(10);
  const fresh = await row(2);
  const done = await row(10, true);

  const redispatched: OutboxId[] = [];
  const result = await sweepOutbox({
    db,
    clock: { now: () => now },
    redispatch: async (ids) => void redispatched.push(...ids),
  });
  expect(redispatched).toContain(old);
  expect(redispatched.indexOf(older)).toBeLessThan(redispatched.indexOf(old));
  expect(redispatched).not.toContain(fresh);
  expect(redispatched).not.toContain(done);
  expect(result.pending).toBe(redispatched.length);
});
