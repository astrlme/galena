import { componentChanged, componentGroupChanged } from "@galena/contracts";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

type View = { id: string; name: string; groupId: string | null; position: number };
type Listing = { groups: View[]; components: View[] };

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  close = built.close;
  owner = new Session(createApp(deps));
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(setup.status).toBe(201);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const list = async () => (await (await owner.call("/v1/components")).json()) as Listing;
const create = async (path: string, body: unknown) => {
  const response = await owner.call(path, body);
  expect(response.status).toBe(201);
  return (await response.json()) as View;
};

describe("components and groups", () => {
  test("an editor adds groups and components, listed in the order they were added", async () => {
    const core = await create("/v1/component-groups", { name: "Core" });
    const api = await create("/v1/components", { name: "API", groupId: core.id });
    const web = await create("/v1/components", { name: "Web" });
    const listing = await list();
    expect(listing.groups.map((g) => g.name)).toEqual(["Core"]);
    expect(listing.components.map((c) => [c.name, c.groupId, c.position])).toEqual([
      ["API", core.id, 0],
      ["Web", null, 1],
    ]);
    expect(api.groupId).toBe(core.id);
    expect(web.groupId).toBeNull();
  });

  test("refuses a blank name and a group that does not exist", async () => {
    await expectProblem(
      await owner.call("/v1/components", { name: "  " }),
      400,
      "validation_failed",
    );
    await expectProblem(
      await owner.call("/v1/components", { name: "Ghost", groupId: v7() }),
      422,
      "group_not_found",
    );
  });

  test("patching renames and regroups; null takes a component out of its group", async () => {
    const { components, groups } = await list();
    const api = components.find((c) => c.name === "API");
    const renamed = await owner.call(`/v1/components/${api?.id}`, { name: "Public API" }, "PATCH");
    expect(await renamed.json()).toMatchObject({ name: "Public API", groupId: groups[0]?.id });
    const ungrouped = await owner.call(`/v1/components/${api?.id}`, { groupId: null }, "PATCH");
    expect(await ungrouped.json()).toMatchObject({ name: "Public API", groupId: null });
  });

  test("reorders with a complete list and refuses a stale one", async () => {
    const before = (await list()).components.map((c) => c.id);
    const reversed = [...before].reverse();
    expect((await owner.call("/v1/components/order", { ids: reversed }, "PUT")).status).toBe(204);
    expect((await list()).components.map((c) => c.id)).toEqual(reversed);
    await expectProblem(
      await owner.call("/v1/components/order", { ids: reversed.slice(1) }, "PUT"),
      409,
      "order_mismatch",
    );
  });

  test("deleting a group leaves its components, ungrouped", async () => {
    const group = await create("/v1/component-groups", { name: "Temporary" });
    const inside = await create("/v1/components", { name: "Inside", groupId: group.id });
    expect((await owner.call(`/v1/component-groups/${group.id}`, undefined, "DELETE")).status).toBe(
      204,
    );
    const survivor = (await list()).components.find((c) => c.id === inside.id);
    expect(survivor?.groupId).toBeNull();
  });

  test("deletes a component, then answers 404 for it", async () => {
    const doomed = await create("/v1/components", { name: "Doomed" });
    expect((await owner.call(`/v1/components/${doomed.id}`, undefined, "DELETE")).status).toBe(204);
    await expectProblem(
      await owner.call(`/v1/components/${doomed.id}`, undefined, "DELETE"),
      404,
      "not_found",
    );
  });
});

test("every change leaves an audit entry and a well-formed outbox event", async () => {
  const audit = await deps.db.select().from(schema.auditLog);
  const events = await deps.db.select().from(schema.outbox);
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining([
      "component_group.created",
      "component.created",
      "component.updated",
      "component.reordered",
      "component_group.deleted",
      "component.deleted",
    ]),
  );
  expect(events).toHaveLength(audit.length);
  for (const { eventType, payload, dispatchedAt } of events) {
    const parser = eventType === "component.changed" ? componentChanged : componentGroupChanged;
    expect(parser.safeParse(payload).success).toBe(true);
    expect(dispatchedAt).toBeNull(); // the worker marks rows dispatched, not the API
  }
});

test("a viewer may list but not change anything", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "viewer" })
    .where(eq(schema.member.role, "owner"));
  expect((await owner.call("/v1/components")).status).toBe(200);
  await expectProblem(await owner.call("/v1/components", { name: "Nope" }), 403, "forbidden");
  await expectProblem(
    await owner.call("/v1/components/order", { ids: [] }, "PUT"),
    403,
    "forbidden",
  );
});
