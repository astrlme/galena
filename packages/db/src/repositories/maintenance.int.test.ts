import { componentId, maintenanceId, workspaceId } from "@galena/contracts";
import type { Maintenance } from "@galena/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, workspace } from "../schema/index.ts";
import { maintenanceRepository } from "./maintenance.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());
const api = componentId.parse(v7());
const web = componentId.parse(v7());

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
  await db.insert(component).values([
    { id: api, workspaceId: acme, name: "API", position: 0 },
    { id: web, workspaceId: acme, name: "Web", position: 1 },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const at = (hour: number) => new Date(Date.UTC(2026, 8, 29, hour));
const newWindow = (overrides: Partial<Maintenance> = {}): Omit<Maintenance, "runId"> => ({
  id: maintenanceId.parse(v7()),
  workspaceId: acme,
  title: "Database upgrade",
  body: "Writes pause for up to 5 minutes.",
  status: "scheduled",
  startsAt: at(22),
  endsAt: at(23),
  version: 1,
  cancelledAt: null,
  componentIds: [api],
  ...overrides,
});

test("a window is scheduled, edited, started and completed, each step checked", async () => {
  const repo = maintenanceRepository(db);
  const window = newWindow();
  expect(await repo.save(window, null)).toBe(true);
  expect(await repo.findById(acme, window.id)).toEqual({ ...window, runId: null });

  // An edit bumps the version and replaces the components; a stale edit is refused.
  const edited = { ...window, endsAt: at(24), version: 2, componentIds: [api, web] };
  expect(await repo.save(edited, 1)).toBe(true);
  expect(await repo.save({ ...window, title: "Stale", version: 2 }, 1)).toBe(false);
  await repo.setRunId(window.id, 2, "run_2");
  expect(await repo.findById(acme, window.id)).toMatchObject({
    title: "Database upgrade",
    endsAt: at(24),
    version: 2,
    runId: "run_2",
    componentIds: [api, web],
  });
  expect((await repo.listUnfinished()).map((m) => m.id)).toContain(window.id);

  // The run for version 1 finds itself superseded.
  expect(
    await repo.transition(
      acme,
      window.id,
      { version: 1, status: "scheduled" },
      { status: "in_progress" },
    ),
  ).toBe(false);
  expect(
    await repo.transition(
      acme,
      window.id,
      { version: 2, status: "scheduled" },
      { status: "in_progress" },
    ),
  ).toBe(true);
  // An edit made while it runs keeps the status the run set.
  expect(await repo.save({ ...edited, status: "scheduled", version: 3 }, 2)).toBe(true);
  expect((await repo.findById(acme, window.id))?.status).toBe("in_progress");
  expect(
    await repo.transition(
      acme,
      window.id,
      { version: 3, status: "in_progress" },
      { status: "completed" },
    ),
  ).toBe(true);

  expect((await repo.listUnfinished()).map((m) => m.id)).not.toContain(window.id);
  expect(await repo.save({ ...edited, version: 4 }, 3)).toBe(false); // completed: no more edits
});

test("cancelling records when; other workspaces see nothing", async () => {
  const repo = maintenanceRepository(db);
  const window = newWindow({ componentIds: [] });
  await repo.save(window, null);
  expect(
    await repo.transition(
      acme,
      window.id,
      { version: 1, status: "scheduled" },
      { status: "completed", cancelledAt: at(20) },
    ),
  ).toBe(true);
  expect(await repo.findById(acme, window.id)).toMatchObject({
    status: "completed",
    cancelledAt: at(20),
  });
  expect(await repo.findById(other, window.id)).toBeUndefined();
  expect(await repo.list(other)).toEqual([]);
  expect((await repo.list(acme)).map((m) => m.id)).toContain(window.id);
});
