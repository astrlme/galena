import { maintenanceId } from "@galena/contracts";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, like } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

type View = {
  id: string;
  status: string;
  endsAt: string;
  cancelledAt: string | null;
  componentIds: string[];
};

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;
let api: string;

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
  api = ((await (await owner.call("/v1/components", { name: "API" })).json()) as { id: string }).id;
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const window = (overrides: object = {}) => ({
  title: "Database upgrade",
  body: "Writes pause for up to 5 minutes.",
  startsAt: inHours(1),
  endsAt: inHours(2),
  componentIds: [],
  ...overrides,
});
const events = async () =>
  (
    await deps.db
      .select({ type: schema.outbox.eventType, payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(like(schema.outbox.eventType, "maintenance.%"))
      .orderBy(schema.outbox.createdAt)
  ).map((e) => ({ type: e.type, data: (e.payload as { data: unknown }).data }));

test("schedule, edit and cancel a window; each step leaves its versioned event", async () => {
  const created = await owner.call("/v1/maintenances", window({ componentIds: [api] }));
  expect(created.status).toBe(201);
  const scheduled = (await created.json()) as View;
  expect(scheduled).toMatchObject({ status: "scheduled", cancelledAt: null, componentIds: [api] });

  const edited = await owner.call(
    `/v1/maintenances/${scheduled.id}`,
    window({ endsAt: inHours(3) }),
    "PUT",
  );
  expect(edited.status).toBe(200);
  expect(((await edited.json()) as View).componentIds).toEqual([]);

  const cancelled = await owner.call(`/v1/maintenances/${scheduled.id}/cancel`, {});
  expect(cancelled.status).toBe(200);
  expect((await cancelled.json()) as View).toMatchObject({
    status: "completed",
    cancelledAt: expect.any(String),
  });

  expect(await events()).toEqual([
    {
      type: "maintenance.scheduled",
      data: { maintenanceId: scheduled.id, version: 1, status: "scheduled" },
    },
    {
      type: "maintenance.scheduled",
      data: { maintenanceId: scheduled.id, version: 2, status: "scheduled" },
    },
    {
      type: "maintenance.cancelled",
      data: { maintenanceId: scheduled.id, version: 2, status: "completed" },
    },
  ]);

  // Completed: no more edits, no second cancel.
  await expectProblem(
    await owner.call(`/v1/maintenances/${scheduled.id}`, window(), "PUT"),
    409,
    "illegal_transition",
  );
  await expectProblem(
    await owner.call(`/v1/maintenances/${scheduled.id}/cancel`, {}),
    409,
    "illegal_transition",
  );
});

test("a running window can be edited but not cancelled", async () => {
  const running = (await (await owner.call("/v1/maintenances", window())).json()) as View;
  await deps.db
    .update(schema.maintenance)
    .set({ status: "in_progress" })
    .where(eq(schema.maintenance.id, maintenanceId.parse(running.id)));
  await expectProblem(
    await owner.call(`/v1/maintenances/${running.id}/cancel`, {}),
    409,
    "illegal_transition",
  );
  const extended = await owner.call(
    `/v1/maintenances/${running.id}`,
    window({ endsAt: inHours(4) }),
    "PUT",
  );
  expect(extended.status).toBe(200);
});

test.each([
  ["ends before it starts", { endsAt: inHours(0.5) }, 400, "validation_failed"],
  ["has already ended", { startsAt: inHours(-3), endsAt: inHours(-2) }, 422, "window_over"],
  ["names an unknown component", { componentIds: [v7()] }, 422, "component_not_found"],
])("refuses a window that %s", async (_, overrides, status, code) => {
  await expectProblem(await owner.call("/v1/maintenances", window(overrides)), status, code);
});

test("a viewer may read windows but not schedule them", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "viewer" })
    .where(eq(schema.member.role, "owner"));
  expect((await owner.call("/v1/maintenances")).status).toBe(200);
  await expectProblem(await owner.call("/v1/maintenances", window()), 403, "forbidden");
});
