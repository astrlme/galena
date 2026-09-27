import { monitorChanged, type OutboxId } from "@galena/contracts";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type Triggered, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

type View = {
  id: string;
  name: string;
  componentId: string | null;
  enabled: boolean;
  publishPolicy: string;
  http: { url: string; method: string; keyword?: string };
  detection: { quorum: number; failThreshold: number };
};

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let owner: Session;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
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

const list = async () =>
  ((await (await owner.call("/v1/monitors")).json()) as { monitors: View[] }).monitors;
const create = async (body: unknown) => {
  const response = await owner.call("/v1/monitors", body);
  expect(response.status).toBe(201);
  return (await response.json()) as View;
};

test("an editor adds a monitor; omitted settings take their documented defaults", async () => {
  const created = await create({ name: "API", http: { url: "https://api.example.com/health" } });
  expect(created).toMatchObject({
    componentId: null,
    enabled: true,
    publishPolicy: "approve",
    http: { url: "https://api.example.com/health", method: "GET" },
    detection: { quorum: 2, failThreshold: 2 },
  });
  expect((await list()).map((m) => m.id)).toEqual([created.id]);
});

test.each([
  ["a private address", "http://10.0.0.8/health", 422, "url_refused"],
  ["the instance metadata service", "http://169.254.169.254/latest/", 422, "url_refused"],
  ["loopback", "http://127.0.0.1:8080/", 422, "url_refused"],
  ["a file URL", "file:///etc/passwd", 400, "validation_failed"],
  ["credentials in the URL", "https://ada:secret@example.com/", 400, "validation_failed"],
])("refuses %s", async (_, url, status, code) => {
  await expectProblem(
    await owner.call("/v1/monitors", { name: "Bad", http: { url } }),
    status,
    code,
  );
});

test("refuses a component that does not exist", async () => {
  const body = { name: "Ghost", componentId: v7(), http: { url: "https://example.com/" } };
  await expectProblem(await owner.call("/v1/monitors", body), 422, "component_not_found");
});

test("PUT replaces every setting and answers 404 for an unknown monitor", async () => {
  const [api] = await list();
  const body = {
    name: "Public API",
    enabled: false,
    publishPolicy: "internal_only",
    http: { url: "https://api.example.com/health", keyword: "ok" },
  };
  const response = await owner.call(`/v1/monitors/${api?.id}`, body, "PUT");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ...body, http: { ...body.http, method: "GET" } });
  expect((await list())[0]).toMatchObject({ name: "Public API", enabled: false });
  await expectProblem(await owner.call(`/v1/monitors/${v7()}`, body, "PUT"), 404, "not_found");
});

test("deletes a monitor, then answers 404 for it", async () => {
  const doomed = await create({ name: "Doomed", http: { url: "https://example.com/" } });
  expect((await owner.call(`/v1/monitors/${doomed.id}`, undefined, "DELETE")).status).toBe(204);
  await expectProblem(
    await owner.call(`/v1/monitors/${doomed.id}`, undefined, "DELETE"),
    404,
    "not_found",
  );
});

test("every change leaves an audit entry and a monitor.changed outbox event", async () => {
  const audit = await deps.db.select().from(schema.auditLog);
  const events = await deps.db.select().from(schema.outbox);
  expect(audit.map((a) => a.action)).toEqual([
    "monitor.created",
    "monitor.updated",
    "monitor.created",
    "monitor.deleted",
  ]);
  expect(events).toHaveLength(audit.length);
  for (const { payload } of events) expect(monitorChanged.safeParse(payload).success).toBe(true);
});

test("each change hands its outbox row to outbox.dispatch once it has committed", async () => {
  const created = await create({ name: "Dispatched", http: { url: "https://example.com/" } });
  const last = triggered.at(-1);
  if (!last) throw new Error("The change triggered nothing.");
  expect(last.task).toBe("outbox.dispatch");
  const { outboxId } = last.payload as { outboxId: OutboxId };
  expect(last.idempotencyKey).toBe(`outbox:${outboxId}`);
  const [row] = await deps.db.select().from(schema.outbox).where(eq(schema.outbox.id, outboxId));
  expect(row?.payload).toMatchObject({ type: "monitor.changed", data: { ids: [created.id] } });
});

test("a change still succeeds when trigger.dev is unreachable", async () => {
  const unreachable: Deps = {
    ...deps,
    engine: {
      trigger: async () => {
        throw new Error("fetch failed");
      },
    },
  };
  const session = new Session(createApp(unreachable));
  await session.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  const response = await session.call("/v1/monitors", {
    name: "Offline",
    http: { url: "https://example.com/offline" },
  });
  expect(response.status).toBe(201);
  const pending = await deps.db
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.eventType, "monitor.changed"));
  expect(pending.at(-1)?.dispatchedAt).toBeNull();
});

test("a viewer may list but not change monitors", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "viewer" })
    .where(eq(schema.member.role, "owner"));
  expect((await owner.call("/v1/monitors")).status).toBe(200);
  await expectProblem(
    await owner.call("/v1/monitors", { name: "Nope", http: { url: "https://example.com/" } }),
    403,
    "forbidden",
  );
});
