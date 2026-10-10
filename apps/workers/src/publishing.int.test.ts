import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentId, monitorConfig, monitorId, snapshot, workspaceId } from "@galena/contracts";
import { fixedClock } from "@galena/core";
import {
  componentRepository,
  createDb,
  type Db,
  monitorRepository,
  nextSnapshotVersion,
  recordMonitorTransition,
  schema,
} from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  localNoteFile,
  localPageStore,
  type PageStore,
  type PublishedNote,
  publishPage,
  type StoredFile,
} from "./publishing.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const web = componentId.parse(v7());
const probe = monitorId.parse(v7());
const clock = fixedClock("2026-09-29T12:00:00.000Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
  await db
    .insert(schema.component)
    .values({ id: web, workspaceId: acme, name: "Web", position: 0 });
  await monitorRepository(db).save(
    monitorConfig.parse({
      id: probe,
      workspaceId: acme,
      componentId: web,
      name: "Web",
      type: "http",
      http: { url: "https://web.example.com/" },
    }),
  );
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

/** Keeps each write's files, keyed by path. */
function memoryStore() {
  const writes: Map<string, StoredFile>[] = [];
  const store: PageStore = {
    write: async (_slug, files) => void writes.push(new Map(files.map((f) => [f.path, f]))),
    read: async () => undefined,
  };
  const published = () => {
    const body = writes.at(-1)?.get("snapshot.json")?.body;
    return typeof body === "string" ? snapshot.parse(JSON.parse(body)) : undefined;
  };
  return { writes, store, published };
}

test("publishes the page, and a late run for an older change leaves the newer page in place", async () => {
  const { writes, store, published } = memoryStore();
  const rebuilds: number[] = [];
  const rebuildHtml = async (version: number) => void rebuilds.push(version);
  const notes: PublishedNote[] = [];
  const deps = {
    db,
    clock,
    store,
    note: { read: async () => notes.at(-1), write: async (n: PublishedNote) => void notes.push(n) },
    url: "https://status.example.com",
    subscribe: false,
    rebuildHtml,
  };

  // A change commits, then its dispatch takes a version and starts the publish.
  const first = await nextSnapshotVersion(db);
  const result = await publishPage({ version: first }, deps);
  expect(result).toEqual({ outcome: "published", published: first + 1 });
  expect(published()).toMatchObject({
    snapshotVersion: first + 1,
    page: { slug: "status", name: "Acme", url: "https://status.example.com", subscribe: false },
    indicator: "none",
    components: [{ id: web, name: "Web", status: "operational" }],
  });
  // The note names the page and each monitor's transition, for the hourly heartbeat.
  expect(notes.at(-1)).toEqual({
    version: 1,
    slug: "status",
    snapshotVersion: first + 1,
    monitors: { [probe]: 0 },
  });

  const components = componentRepository(db);
  const current = await components.findById(acme, web);
  if (!current) throw new Error("no component");
  await components.save({ ...current, manualStatus: "major_outage" });
  const second = await nextSnapshotVersion(db);
  expect((await publishPage({ version: second }, deps)).outcome).toBe("published");
  expect(published()?.components[0]?.status).toBe("major_outage");

  await recordMonitorTransition(db, {
    workspaceId: acme,
    monitorId: probe,
    from: "unknown",
    to: "up",
    seq: 1,
    at: clock.now(),
  });
  const third = await nextSnapshotVersion(db);
  expect((await publishPage({ version: third }, deps)).outcome).toBe("published");
  expect(notes.at(-1)).toMatchObject({ snapshotVersion: third + 1, monitors: { [probe]: 1 } });

  // The first change's run again (a retry, or a slow queue): the page already shows it.
  expect(await publishPage({ version: first }, deps)).toEqual({ outcome: "superseded" });
  expect(writes).toHaveLength(3);
  expect(rebuilds).toEqual([first + 1, second + 1, third + 1]);
  expect(published()?.indicator).toBe("critical");
});

test("a note that can't be written doesn't hold the page back", async () => {
  const { store, published } = memoryStore();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rebuilds: number[] = [];
  const version = await nextSnapshotVersion(db);
  const result = await publishPage(
    { version },
    {
      db,
      clock,
      store,
      note: {
        read: async () => undefined,
        write: async () => {
          throw new Error("AccessDenied");
        },
      },
      url: "https://status.example.com",
      subscribe: false,
      rebuildHtml: async (v) => void rebuilds.push(v),
    },
  );
  expect(result).toEqual({ outcome: "published", published: version + 1 });
  expect(published()?.snapshotVersion).toBe(version + 1);
  expect(rebuilds).toEqual([version + 1]);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test("the local store writes each file under the page's slug", async () => {
  const dir = await mkdtemp(join(tmpdir(), "galena-pages-"));
  try {
    await localPageStore(dir).write("status", [
      { path: "favicons/operational.svg", body: "<svg/>", contentType: "image/svg+xml" },
    ]);
    expect(await readFile(join(dir, "status", "favicons", "operational.svg"), "utf8")).toBe(
      "<svg/>",
    );
    expect(await localPageStore(dir).read("status", "favicons/operational.svg")).toBe("<svg/>");
    expect(await localPageStore(dir).read("status", "snapshot.json")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the note reads back as written, and as absent when missing or unreadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "galena-config-"));
  try {
    const file = localNoteFile(dir);
    expect(await file.read()).toBeUndefined();
    const note: PublishedNote = { version: 1, slug: "status", snapshotVersion: 7, monitors: {} };
    await file.write(note);
    expect(await file.read()).toEqual(note);
    await writeFile(join(dir, "published.json"), "{not json");
    expect(await file.read()).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
