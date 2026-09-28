import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "./app.ts";
import { testDeps } from "./test-deps.ts";
import { expectProblem, Session } from "./test-session.ts";

// A setup that failed after creating the owner's account (the workspace insert failing, or
// Aurora resuming too slowly) leaves a user with no workspace. Running setup again finishes it.
let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
const OWNER = { name: "Ada", email: "ada@example.com", password: "correct horse battery" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
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

test("a second setup with the same email and password finishes it and signs the owner in", async () => {
  const owner = new Session(createApp(deps));
  const response = await owner.call("/v1/setup", { workspaceName: "Acme", ...OWNER });
  expect(response.status).toBe(201);
  const me = await owner.call("/v1/me");
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ email: OWNER.email, role: "owner" });
});
