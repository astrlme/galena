import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentId, workspaceId } from "@galena/contracts";
import { fixedClock } from "@galena/core";
import { createDb, type Db, nextSnapshotVersion, schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { astroBuild, rebuildHtml } from "./html.ts";
import { localPageStore, publishPage } from "./publishing.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
let dir: string;
const acme = workspaceId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
  await db
    .insert(schema.component)
    .values({ id: componentId.parse(v7()), workspaceId: acme, name: "Checkout", position: 0 });
  dir = await mkdtemp(join(tmpdir(), "galena-pages-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await close?.();
  await container?.stop();
});

test("builds the HTML from the published snapshot once per version, with no form when email is off", async () => {
  const store = localPageStore(dir);
  const asked: number[] = [];
  const clock = fixedClock("2026-09-29T12:00:00.000Z");
  const url = "https://status.example.com";
  const rebuild = async (version: number) => void asked.push(version);
  await publishPage(
    { version: await nextSnapshotVersion(db) },
    { db, clock, store, url, subscribe: false, rebuildHtml: rebuild },
  );
  const version = asked[0] ?? 0;

  const deps = { db, store, build: astroBuild };
  expect(await rebuildHtml({ version }, deps)).toEqual({ outcome: "built", built: version });
  const html = await readFile(join(dir, "status", "index.html"), "utf8");
  expect(html).toContain("Checkout");
  expect(html).toContain(`data-snapshot-version="${version}"`);
  expect(html).not.toContain('id="subscribe"');
  expect(html).not.toContain("subscribe-link");
  expect(await rebuildHtml({ version }, deps)).toEqual({ outcome: "superseded" });
}, 120_000);
