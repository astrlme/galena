import { readFileSync } from "node:fs";
import { apiKeyId, memberId } from "@galena/contracts";
import { createApiKey, schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { newApiKey } from "../api-keys.ts";
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

// The document as the dashboard publishes it at /openapi.json (the web build serves this file).
type Schema = { $ref?: string; required?: string[]; properties?: Record<string, unknown> };
type Operation = {
  security?: unknown[];
  requestBody: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { content: { "application/json": { schema: Schema } } }>;
};
const published = JSON.parse(
  readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
) as {
  security: Record<string, string[]>[];
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string }>;
    schemas?: Record<string, Schema>;
  };
  paths: Record<string, Record<string, Operation>>;
};
const resolve = (schema: Schema): Schema =>
  schema.$ref
    ? (published.components.schemas?.[schema.$ref.split("/").at(-1) ?? ""] ?? {})
    : schema;

test("a write key creates an incident through the published OpenAPI description; a read key is refused", async () => {
  // What a script's author reads: the key scheme, the operation, what to send and what comes back.
  const scheme = Object.entries(published.components.securitySchemes).find(
    ([, s]) => s.type === "http" && s.scheme === "bearer",
  );
  expect(published.security).toContainEqual({ [scheme?.[0] ?? "none"]: [] });
  const path = "/v1/incidents";
  const operation = published.paths[path]?.post;
  expect(operation?.security).toBeUndefined(); // so the document-wide schemes apply
  const body = resolve(operation?.requestBody.content["application/json"].schema ?? {});
  const answer = resolve(operation?.responses["201"]?.content["application/json"].schema ?? {});

  const write = await makeKey("Deploy script", "write");
  const read = await makeKey("Status board", "read");
  expect(write.key).toMatch(/^gln_[\w-]{54}$/);
  expect(write.key.startsWith(write.apiKey.prefix)).toBe(true);

  const incident: Record<string, string> = {
    title: "Elevated errors on the API",
    impact: "minor",
    body: "We are looking into errors on the API.",
  };
  expect(Object.keys(incident)).toEqual(expect.arrayContaining(body.required ?? ["?"]));
  const created = await withKey(write.key, path, { method: "POST", body: incident });
  expect(created.status).toBe(201);
  expect(Object.keys((await created.json()) as object)).toEqual(
    expect.arrayContaining(answer.required ?? ["?"]),
  );
  await expectProblem(
    await withKey(read.key, path, { method: "POST", body: incident }),
    403,
    "forbidden",
  );
  // Reading is what a read key is for, and nothing the API answers is for a cache.
  const listed = await withKey(read.key, path);
  expect([listed.status, listed.headers.get("cache-control")]).toEqual([200, "no-store"]);

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
  await expectProblem(await withKey(`gln_${"x".repeat(54)}`, "/v1/me"), 401, "invalid_api_key");
  const audit = await deps.db.select().from(schema.auditLog);
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining(["api_key.created", "api_key.deleted"]),
  );
});

test("a key in any case of the scheme works, and a bad one is refused even with a session", async () => {
  const read = await makeKey("Scheme", "read");
  const lower = await app.request("/v1/me", { headers: { authorization: `bearer ${read.key}` } });
  expect(await lower.json()).toMatchObject({ userId: ownerId, role: "viewer" });
  // The signed-in owner's cookie doesn't rescue a request that sent a key: it is about the key.
  for (const junk of ["Bearer nonsense", `Bearer gln_${"x".repeat(54)}`]) {
    await expectProblem(
      await owner.call("/v1/me", undefined, "GET", { authorization: junk }),
      401,
      "invalid_api_key",
    );
  }
});

test("a maker who leaves the workspace takes their keys with them", async () => {
  const [ws] = await deps.db.select().from(schema.workspace);
  const userId = `user-${v7()}`;
  await deps.db
    .insert(schema.user)
    .values({ id: userId, name: "Grace", email: "grace@example.com", emailVerified: true });
  await deps.db
    .insert(schema.member)
    .values({ id: memberId.parse(v7()), workspaceId: ws?.id as never, userId, role: "admin" });
  const { key, prefix, hash } = newApiKey(deps.keys);
  await createApiKey(deps.db, {
    id: apiKeyId.parse(v7()),
    workspaceId: ws?.id as never,
    name: "Grace's script",
    scope: "write",
    prefix,
    hash,
    createdByUserId: userId,
  });
  expect(await (await withKey(key, "/v1/me")).json()).toMatchObject({ userId, role: "editor" });

  await deps.db.delete(schema.member).where(eq(schema.member.userId, userId));
  await expectProblem(await withKey(key, "/v1/me"), 401, "invalid_api_key");
  const left = await deps.db.select().from(schema.apiKey).where(eq(schema.apiKey.hash, hash));
  expect(left).toEqual([]);
});

test("a workspace holds at most 50 API keys; the next is refused until one is deleted", async () => {
  const listed = async () =>
    ((await (await owner.call("/v1/api-keys")).json()) as unknown[]).length;
  for (let n = await listed(); n < 50; n++) await makeKey(`Script ${n}`, "read");
  const refused = await owner.call("/v1/api-keys", { name: "One too many", scope: "read" });
  await expectProblem(refused, 409, "limit_reached");
  expect(await listed()).toBe(50);
});
