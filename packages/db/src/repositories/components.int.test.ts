import { componentGroupId, componentId, type WorkspaceId, workspaceId } from "@galena/contracts";
import type { Component } from "@galena/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { componentGroup, workspace } from "../schema/index.ts";
import { componentRepository } from "./components.ts";

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

const newComponent = (ws: WorkspaceId, overrides: Partial<Component> = {}): Component => ({
  id: componentId.parse(v7()),
  workspaceId: ws,
  groupId: null,
  name: "API",
  description: null,
  position: 0,
  status: "operational",
  manualStatus: null,
  ...overrides,
});

describe("migrations", () => {
  test("create the tables with workspace_id everywhere but the identity tables", async () => {
    // Db is driver-neutral, so raw results are untyped; this test runs on node-postgres.
    const { rows } = (await db.execute(sql`
      select table_name, bool_or(column_name = 'workspace_id') as has_workspace
      from information_schema.columns where table_schema = 'public'
      group by table_name order by table_name`)) as unknown as {
      rows: { table_name: string; has_workspace: boolean }[];
    };
    const exempt = ["account", "session", "two_factor", "user", "verification", "workspace"];
    expect(rows).toHaveLength(25);
    for (const { table_name, has_workspace } of rows) {
      expect(has_workspace, table_name).toBe(!exempt.includes(table_name));
    }
  });

  test("every enum takes text, which is how the RDS Data API sends string parameters", async () => {
    const missing = (await db.execute(sql`
      select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and n.nspname = 'public' and not exists (
        select 1 from pg_cast c
        where c.castsource = 'text'::regtype and c.casttarget = t.oid and c.castcontext = 'i')
      order by 1`)) as unknown as { rows: { typname: string }[] };
    expect(missing.rows.map((r) => r.typname)).toEqual([]);
    // Insert a text-typed parameter into an enum column, as the Data API sends it.
    const stored = (await db.transaction(async (tx) => {
      await tx.execute(sql`create temporary table enum_probe (role member_role) on commit drop`);
      await tx.execute(sql`insert into enum_probe values (${"owner"}::text)`);
      return tx.execute(sql`select role::text as role from enum_probe`);
    })) as unknown as { rows: { role: string }[] };
    expect(stored.rows).toEqual([{ role: "owner" }]);
  });
});

describe("component repository", () => {
  const repo = () => componentRepository(db);

  test("saves a component and reads it back as a domain object", async () => {
    const api = newComponent(acme, { description: "Public REST API" });
    await repo().save(api);
    expect(await repo().findById(acme, api.id)).toEqual(api);
  });

  test("save updates an existing component", async () => {
    const api = newComponent(acme);
    await repo().save(api);
    await repo().save({ ...api, name: "API v2", manualStatus: "major_outage" });
    expect(await repo().findById(acme, api.id)).toMatchObject({
      name: "API v2",
      manualStatus: "major_outage",
    });
  });

  test("lists a workspace's components by position and never another workspace's", async () => {
    const ws = workspaceId.parse(v7());
    await db.insert(workspace).values({ id: ws, name: "Ordered" });
    for (const c of [
      newComponent(ws, { name: "Third", position: 2 }),
      newComponent(ws, { name: "First", position: 0 }),
      newComponent(ws, { name: "Second", position: 1 }),
      newComponent(other, { name: "Theirs" }),
    ]) {
      await repo().save(c);
    }
    const names = (await repo().listByWorkspace(ws)).map((c) => c.name);
    expect(names).toEqual(["First", "Second", "Third"]);
  });

  test("never reads, overwrites or deletes another workspace's component", async () => {
    const theirs = newComponent(other, { name: "Theirs" });
    await repo().save(theirs);
    expect(await repo().findById(acme, theirs.id)).toBeUndefined();

    await repo().save({ ...theirs, workspaceId: acme, name: "Hijacked" });
    await repo().delete(acme, theirs.id);
    expect(await repo().findById(other, theirs.id)).toMatchObject({ name: "Theirs" });
  });

  test("deleting a group leaves its components ungrouped", async () => {
    const groupId = componentGroupId.parse(v7());
    await db
      .insert(componentGroup)
      .values({ id: groupId, workspaceId: acme, name: "Core", position: 0 });
    const api = newComponent(acme, { groupId });
    await repo().save(api);
    await db.delete(componentGroup).where(eq(componentGroup.id, groupId));
    expect((await repo().findById(acme, api.id))?.groupId).toBeNull();
  });

  test("deletes a component", async () => {
    const api = newComponent(acme);
    await repo().save(api);
    await repo().delete(acme, api.id);
    expect(await repo().findById(acme, api.id)).toBeUndefined();
  });
});
