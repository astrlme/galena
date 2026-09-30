import { webhookEndpointId } from "@galena/contracts";
import { createEndpoint } from "@galena/db";
import { seal } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;
let app: ReturnType<typeof createApp>;
let workspaceId: string;

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
  workspaceId = ((await setup.json()) as { workspaceId: string }).workspaceId;
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

type Created = { endpoint: { id: string; kind: string; state: string }; secret: string | null };

test("adds a Slack webhook and an outgoing webhook; neither URL comes back", async () => {
  const slack = await owner.call("/v1/webhook-endpoints", {
    kind: "slack",
    name: "#status",
    url: "https://hooks.slack.com/services/T000/B000/XXXX",
  });
  expect(slack.status).toBe(201);
  expect(((await slack.json()) as Created).secret).toBeNull();

  const hook = await owner.call("/v1/webhook-endpoints", {
    kind: "webhook",
    name: "Ops",
    url: "https://ops.example.com/galena",
  });
  const created = (await hook.json()) as Created;
  expect(created.secret).toMatch(/^whsec_/);

  const list = await owner.call("/v1/webhook-endpoints");
  const text = await list.text();
  expect(JSON.parse(text).map((e: { name: string }) => e.name)).toEqual(["#status", "Ops"]);
  expect(text).not.toContain("hooks.slack.com");
  expect(text).not.toContain("whsec_");

  expect(
    (await owner.call(`/v1/webhook-endpoints/${created.endpoint.id}`, undefined, "DELETE")).status,
  ).toBe(204);
  expect(((await (await owner.call("/v1/webhook-endpoints")).json()) as unknown[]).length).toBe(1);
});

test("refuses a Slack URL that isn't Slack's, plain http, and private addresses", async () => {
  const post = (url: string, kind = "webhook") =>
    owner.call("/v1/webhook-endpoints", { kind, name: "x", url });
  await expectProblem(await post("https://example.com/hook", "slack"), 400, "validation_failed");
  await expectProblem(await post("http://ops.example.com/hook"), 400, "validation_failed");
  await expectProblem(await post("https://127.0.0.1/hook"), 422, "blocked_by_guard");
});

test("a test message to an unreachable endpoint says so instead of failing", async () => {
  const id = webhookEndpointId.parse(v7());
  // Saved directly: the API wouldn't accept a loopback address, and sends refuse it too.
  await createEndpoint(deps.db, {
    id,
    workspaceId: workspaceId as never,
    kind: "webhook",
    name: "Local",
    componentIds: [],
    urlSealed: seal(deps.keys, "http://127.0.0.1:9/hook"),
    secretSealed: seal(deps.keys, "whsec_dGVzdA=="),
  });
  const res = await owner.call(`/v1/webhook-endpoints/${id}/test`, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false, status: 0 });
});

test("lists subscribers with masked addresses and removes one", async () => {
  await app.request("/public/subscribe", {
    method: "POST",
    body: new URLSearchParams({ email: "grace@example.com" }),
  });
  const list = (await (await owner.call("/v1/subscribers")).json()) as {
    id: string;
    email: string;
    state: string;
  }[];
  expect(list).toMatchObject([{ email: "g***@example.com", state: "pending_confirmation" }]);
  const id = list[0]?.id ?? "";
  expect((await owner.call(`/v1/subscribers/${id}`, undefined, "DELETE")).status).toBe(204);
  expect(await (await owner.call("/v1/subscribers")).json()).toEqual([]);
});
