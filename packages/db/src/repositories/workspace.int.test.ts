import { memberId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { member, user, workspace } from "../schema/index.ts";
import {
  createWorkspace,
  findMemberEmail,
  findMembership,
  listMemberIds,
  workspaceExists,
} from "./workspace.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  ({ db, close } = client);
  await client.migrate();
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

test("concurrent first-run setups create exactly one workspace with its owner", async () => {
  const users = ["ada", "bob", "cy", "dee", "eve"];
  await db.insert(user).values(users.map((id) => ({ id, name: id, email: `${id}@example.com` })));
  expect(await workspaceExists(db)).toBe(false);
  // Widen the race: each workspace insert now takes 200 ms, so setups without the lock
  // would all see an empty table and all insert.
  await db.execute(sql`create function slow_insert() returns trigger language plpgsql
    as $$ begin perform pg_sleep(0.2); return new; end $$`);
  await db.execute(sql`create trigger slow_workspace_insert before insert on workspace
    for each row execute function slow_insert()`);

  const outcomes = await Promise.all(
    users.map((userId) =>
      createWorkspace(db, {
        id: workspaceId.parse(v7()),
        name: `Workspace of ${userId}`,
        owner: { memberId: memberId.parse(v7()), userId },
      }),
    ),
  );

  expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
  expect(await db.select().from(workspace)).toHaveLength(1);
  const owners = await Promise.all(users.map((u) => findMembership(db, u)));
  expect(owners.filter((m) => m?.role === "owner")).toHaveLength(1);
});

test("lists every member of the workspace and finds each one's address", async () => {
  const [acme] = await db.select().from(workspace);
  const [owner] = await db.select().from(member);
  if (!acme || !owner) throw new Error("The setup test above makes the workspace and its owner.");
  const viewer = memberId.parse(v7());
  await db.insert(user).values({ id: "fay", name: "Fay", email: "fay@example.com" });
  await db
    .insert(member)
    .values({ id: viewer, workspaceId: acme.id, userId: "fay", role: "viewer" });

  expect((await listMemberIds(db, acme.id)).toSorted()).toEqual([owner.id, viewer].toSorted());
  expect(await findMemberEmail(db, viewer)).toBe("fay@example.com");
  expect(await listMemberIds(db, workspaceId.parse(v7()))).toEqual([]);
  expect(await findMemberEmail(db, memberId.parse(v7()))).toBeUndefined();
});
