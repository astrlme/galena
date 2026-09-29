import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentId, snapshot, workspaceId } from "@galena/contracts";
import { fixedClock } from "@galena/core";
import { componentRepository, createDb, type Db, nextSnapshotVersion, schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { localPageStore, type PageStore, publishPage, type StoredFile } from "./publishing.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const web = componentId.parse(v7());
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
  const deps = { db, clock, store, url: "https://status.example.com", rebuildHtml };

  // A change commits, then its dispatch takes a version and starts the publish.
  const first = await nextSnapshotVersion(db);
  const result = await publishPage({ version: first }, deps);
  expect(result).toEqual({ outcome: "published", published: first + 1 });
  expect(published()).toMatchObject({
    snapshotVersion: first + 1,
    page: { slug: "status", name: "Acme", url: "https://status.example.com" },
    indicator: "none",
    components: [{ id: web, name: "Web", status: "operational" }],
  });

  const components = componentRepository(db);
  const current = await components.findById(acme, web);
  if (!current) throw new Error("no component");
  await components.save({ ...current, manualStatus: "major_outage" });
  const second = await nextSnapshotVersion(db);
  expect((await publishPage({ version: second }, deps)).outcome).toBe("published");
  expect(published()?.components[0]?.status).toBe("major_outage");

  // The first change's run again (a retry, or a slow queue): the page already shows it.
  expect(await publishPage({ version: first }, deps)).toEqual({ outcome: "superseded" });
  expect(writes).toHaveLength(2);
  expect(rebuilds).toEqual([first + 1, second + 1]);
  expect(published()?.indicator).toBe("critical");
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
