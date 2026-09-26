import {
  componentId,
  type MonitorConfig,
  monitorConfig,
  monitorId,
  type WorkspaceId,
  workspaceId,
} from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, workspace } from "../schema/index.ts";
import { monitorRepository } from "./monitors.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values([
    { id: acme, name: "Acme" },
    { id: other, name: "Other" },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const newMonitor = (ws: WorkspaceId, overrides: Partial<MonitorConfig> = {}) =>
  monitorConfig.parse({
    id: monitorId.parse(v7()),
    workspaceId: ws,
    componentId: null,
    name: "API health",
    type: "http",
    http: { url: "https://api.example.com/health", keyword: "ok", expectedStatus: [200, 204] },
    detection: { quorum: 3 },
    ...overrides,
  });

test("saves a monitor and reads its check and detection settings back unchanged", async () => {
  const repo = monitorRepository(db);
  const monitor = newMonitor(acme);
  await repo.save(monitor);
  expect(await repo.findById(acme, monitor.id)).toEqual(monitor);

  const edited = { ...monitor, enabled: false, http: { ...monitor.http, method: "HEAD" as const } };
  await repo.save(edited);
  expect(await repo.findById(acme, monitor.id)).toEqual(edited);
});

test("never lists, reads, overwrites or deletes another workspace's monitor", async () => {
  const repo = monitorRepository(db);
  const theirs = newMonitor(other, { name: "Theirs" });
  await repo.save(theirs);

  expect((await repo.listByWorkspace(acme)).map((m) => m.id)).not.toContain(theirs.id);
  expect(await repo.findById(acme, theirs.id)).toBeUndefined();
  await repo.save({ ...theirs, workspaceId: acme, name: "Hijacked" });
  await repo.delete(acme, theirs.id);
  expect(await repo.findById(other, theirs.id)).toEqual(theirs);
});

test("deleting its component leaves the monitor without one", async () => {
  const repo = monitorRepository(db);
  const api = componentId.parse(v7());
  await db.insert(component).values({ id: api, workspaceId: acme, name: "API", position: 0 });
  const monitor = newMonitor(acme, { componentId: api });
  await repo.save(monitor);
  await db.delete(component);
  expect((await repo.findById(acme, monitor.id))?.componentId).toBeNull();
});
