import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "./app.ts";
import { SETUP_TOKEN_HEADER } from "./http.ts";
import { testDeps } from "./test-deps.ts";
import { expectProblem, Session } from "./test-session.ts";

// A setup that failed after creating the owner's account (the workspace insert failing, or
// Aurora resuming too slowly) leaves a user with no workspace. Running setup again finishes it.
let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: ReturnType<typeof testDeps>["triggered"];
const OWNER = { name: "Ada", email: "ada@example.com", password: "correct horse battery" };
const TOKEN = "a-test-setup-token-not-a-secret";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
  close = built.close;
  await deps.auth.api.signUpEmail({ body: OWNER });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

test("a second setup with a wrong password for the existing account is refused", async () => {
  await expectProblem(
    await new Session(createApp(deps)).call("/v1/setup", {
      workspaceName: "Acme",
      ...OWNER,
      password: "not the password at all",
    }),
    422,
    "sign_up_rejected",
  );
});

// In AWS, setup needs the deployment's setup token, and is refused when it has none.
test.each([
  ["without the setup token", { token: TOKEN }, {}],
  ["with a wrong setup token", { token: TOKEN }, { [SETUP_TOKEN_HEADER]: "not-the-token" }],
  ["when the deployment has no setup token", {}, { [SETUP_TOKEN_HEADER]: TOKEN }],
] as const)("setup %s is refused", async (_, setup, headers) => {
  await expectProblem(
    await new Session(createApp({ ...deps, setup })).call(
      "/v1/setup",
      { workspaceName: "Acme", ...OWNER },
      "POST",
      headers,
    ),
    403,
    "setup_token_required",
  );
});

test("with the setup token, a second setup with the same email and password finishes it, signs the owner in and starts the page's first publish, even if that can't be queued", async () => {
  // Records the trigger, then fails like an unreachable queue: the hourly heartbeat publishes then.
  const engine: Deps["engine"] = {
    async trigger(...args) {
      await deps.engine.trigger(...args);
      throw new Error("queue unreachable");
    },
  };
  const owner = new Session(createApp({ ...deps, engine, setup: { token: TOKEN } }));
  const response = await owner.call("/v1/setup", { workspaceName: "Acme", ...OWNER }, "POST", {
    [SETUP_TOKEN_HEADER]: TOKEN,
  });
  expect(response.status).toBe(201);
  const { workspaceId } = (await response.json()) as { workspaceId: string };
  expect(triggered).toContainEqual(
    expect.objectContaining({ task: "rollup.uptime", idempotencyKey: `setup:${workspaceId}` }),
  );
  const me = await owner.call("/v1/me");
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ email: OWNER.email, role: "owner" });
});
