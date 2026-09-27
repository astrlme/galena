import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MonitorsFile,
  monitorConfig,
  monitorId,
  monitorsFile,
  outboxId,
  type WorkspaceId,
  workspaceId,
} from "@galena/contracts";
import { fixedClock } from "@galena/core";
import {
  createDb,
  type Db,
  findOutboxRow,
  monitorRepository,
  recordChange,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dispatchOutbox, localMonitorsFile } from "./outbox.ts";

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

  expect(await dispatchOutbox(id, { db, clock, writeMonitorsFile })).toBe("dispatched");
  expect(files).toHaveLength(1);
  expect(files[0]?.monitors.map((m) => m.http.url)).toEqual(["https://api.example.com/health"]);
  const row = await findOutboxRow(db, id);
  expect(row?.dispatchedAt?.toISOString()).toBe("2026-09-28T10:00:00.000Z");

  // A second run for the same row, e.g. the backstop, finds it done and writes nothing.
  expect(await dispatchOutbox(id, { db, clock, writeMonitorsFile })).toBe("already_dispatched");
  expect(files).toHaveLength(1);
});

test("a row whose transaction rolled back is skipped", async () => {
  const { files, writeMonitorsFile } = collector();
  const missing = outboxId.parse(v7());
  expect(await dispatchOutbox(missing, { db, clock, writeMonitorsFile })).toBe("rolled_back");
  expect(files).toHaveLength(0);
});

test("other event types are marked dispatched without touching monitors.json", async () => {
  const id = await outboxRow("component.changed");
  const { files, writeMonitorsFile } = collector();
  expect(await dispatchOutbox(id, { db, clock, writeMonitorsFile })).toBe("dispatched");
  expect(files).toHaveLength(0);
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
