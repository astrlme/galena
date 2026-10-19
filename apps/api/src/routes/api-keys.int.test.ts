import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;
let app: ReturnType<typeof createApp>;
let ownerId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  close = built.close;
  app = createApp(deps);
  owner = new Session(app);
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  ownerId = ((await setup.json()) as { userId: string }).userId;
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

type Created = { apiKey: { id: string; prefix: string; scope: string }; key: string };
const makeKey = async (name: string, scope: string) =>
  (await (await owner.call("/v1/api-keys", { name, scope })).json()) as Created;
/** A script's request: no cookies, only the key. */
const withKey = (key: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("a write key creates an incident through the published OpenAPI description; a read key is refused", async () => {
  // What a script's author reads: the document, its key scheme, and the operation it calls.
  const doc = (await (await app.request("/openapi.json")).json()) as {
    security: Record<string, string[]>[];
    components: { securitySchemes: Record<string, { type: string; scheme?: string }> };
    paths: Record<string, Record<string, { security?: unknown[]; requestBody?: unknown }>>;
  };
  expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
  expect(doc.security).toContainEqual({ apiKey: [] });
  const operation = doc.paths["/v1/incidents"]?.post;
  expect(operation?.requestBody).toBeDefined();
  expect(operation?.security).toBeUndefined(); // so the document-wide schemes apply

  const write = await makeKey("Deploy script", "write");
  const read = await makeKey("Status board", "read");
  expect(write.key).toMatch(/^gln_[\w-]{43}$/);
  expect(write.key.startsWith(write.apiKey.prefix)).toBe(true);

  const incident = {
    title: "Elevated errors on the API",
    impact: "minor",
    body: "We are looking into errors on the API.",
  };
  const created = await withKey(write.key, "/v1/incidents", { method: "POST", body: incident });
  expect(created.status).toBe(201);
  await expectProblem(
    await withKey(read.key, "/v1/incidents", { method: "POST", body: incident }),
    403,
    "forbidden",
  );
  // Reading is what a read key is for.
  expect((await withKey(read.key, "/v1/incidents")).status).toBe(200);

  // The key acts as the admin who made it: the audit log names them.
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit.find((a) => a.action === "incident.created")).toMatchObject({
    actorUserId: ownerId,
  });
});

test("keys list without the keys themselves, can't make more keys, and stop working once deleted", async () => {
  const admin = await makeKey("Ops", "admin");
  const list = await (await owner.call("/v1/api-keys")).text();
  expect(list).toContain(admin.apiKey.prefix);
  expect(list).not.toContain(admin.key);

  await expectProblem(
    await withKey(admin.key, "/v1/api-keys", {
      method: "POST",
      body: { name: "x", scope: "read" },
    }),
    403,
    "session_required",
  );
  // An admin key reads what admins read.
  expect((await withKey(admin.key, "/v1/webhook-endpoints")).status).toBe(200);

  expect((await owner.call(`/v1/api-keys/${admin.apiKey.id}`, undefined, "DELETE")).status).toBe(
    204,
  );
  await expectProblem(await withKey(admin.key, "/v1/me"), 401, "invalid_api_key");
  await expectProblem(await withKey(`gln_${"x".repeat(43)}`, "/v1/me"), 401, "invalid_api_key");
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining(["api_key.created", "api_key.deleted"]),
  );
});
