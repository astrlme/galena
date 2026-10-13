import { readFileSync } from "node:fs";
import { componentId, workspaceId } from "@galena/contracts";
import { schema } from "@galena/db";
import { linkToken } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { TEST_BASE_URL, type Triggered, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let owner: Session;
let app: ReturnType<typeof createApp>;
const api = componentId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
  close = built.close;
  app = createApp(deps);
  owner = new Session(app);
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  const ws = workspaceId.parse(((await setup.json()) as { workspaceId: string }).workspaceId);
  await deps.db
    .insert(schema.component)
    .values({ id: api, workspaceId: ws, name: "API", position: 0 });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const firing = readFileSync(
  new URL(
    "../../../../packages/integrations/test/fixtures/alertmanager/firing.json",
    import.meta.url,
  ),
  "utf8",
);
type Created = { integration: { id: string; name: string }; url: string };

/** An alert posted to a hook URL, as a source would send it. */
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  app.request(new URL(url).pathname, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

async function created(name = "Prometheus"): Promise<Created> {
  const response = await owner.call("/v1/integrations", {
    source: "alertmanager",
    name,
    routes: [{ match: { service: "api" }, componentIds: [api] }],
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

test("an integration's hook URL appears once, and a new one replaces it", async () => {
  const { integration, url } = await created();
  expect(url).toMatch(
    new RegExp(`^${TEST_BASE_URL}/hooks/alertmanager/hook\\.${integration.id}\\.`),
  );

  const list = await (await owner.call("/v1/integrations")).text();
  expect(JSON.parse(list)).toEqual([
    expect.objectContaining({
      id: integration.id,
      publishPolicy: "approve",
      routes: [{ match: { service: "api" }, componentIds: [api], downStatus: "major_outage" }],
      lastSignalAt: null,
      lastOutcome: null,
    }),
  ]);
  expect(list).not.toContain("/hooks/");

  const updated = await owner.call(
    `/v1/integrations/${integration.id}`,
    { name: "Prod Prometheus", publishPolicy: "auto", routes: [] },
    "PUT",
  );
  expect(await updated.json()).toMatchObject({ name: "Prod Prometheus", publishPolicy: "auto" });

  const renewed = await owner.call(`/v1/integrations/${integration.id}/url`, {});
  const { url: next } = (await renewed.json()) as { url: string };
  expect(next).not.toBe(url);

  expect((await owner.call(`/v1/integrations/${integration.id}`, undefined, "DELETE")).status).toBe(
    204,
  );
  await expectProblem(
    await owner.call(`/v1/integrations/${integration.id}/url`, {}),
    404,
    "not_found",
  );
});

test("a hook hands each alert group to signal.ingest without reading the database", async () => {
  const { integration, url } = await created("Hook");
  triggered.length = 0;
  const response = await post(url, firing);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: 1 });
  const [run] = triggered;
  expect(run).toMatchObject({
    task: "signal.ingest",
    payload: {
      integrationId: integration.id,
      signal: { source: "alertmanager", status: "firing", startsAt: "2026-10-13T10:01:00.000Z" },
    },
  });
  const { signal, tokenIssuedAt } = (run?.payload ?? {}) as {
    signal: { fingerprint: string };
    tokenIssuedAt: string;
  };
  expect(run?.idempotencyKey).toBe(
    `sig:${integration.id}:${signal.fingerprint}:firing:2026-10-13T10:01:00.000Z`,
  );
  expect(url).toContain(String(Date.parse(tokenIssuedAt) / 1000));

  // Alertmanager repeating the group gives the same key, so trigger.dev starts no second run.
  await post(url, firing);
  expect(triggered[1]?.idempotencyKey).toBe(run?.idempotencyKey);

  const generic = await owner.call("/v1/integrations", { source: "generic", name: "Cron" });
  const genericUrl = ((await generic.json()) as Created).url;
  const alerts = [
    { key: "backup", status: "firing", startsAt: "2026-10-13T10:00:00Z" },
    { key: "disk", status: "resolved", startsAt: "2026-10-13T09:00:00Z" },
  ];
  expect(await (await post(genericUrl, JSON.stringify(alerts))).json()).toEqual({ accepted: 2 });
});

test("a hook refuses a URL that isn't one, a body its source wouldn't send, and a huge body", async () => {
  const { integration, url } = await created("Strict");
  const { pathname } = new URL(url);
  const token = pathname.split("/").at(-1) ?? "";
  await expectProblem(await post(url.replace(/.$/, "x"), firing), 404, "unknown_hook");
  await expectProblem(
    await post(url.replace("/alertmanager/", "/sentry/"), firing),
    404,
    "unknown_hook",
  );
  const confirm = linkToken(deps.keys, "confirm", integration.id, new Date());
  await expectProblem(await post(url.replace(token, confirm), firing), 404, "unknown_hook");

  await expectProblem(await post(url, "not json"), 400, "bad_alert_body");
  await expectProblem(await post(url, JSON.stringify({ key: "x" })), 400, "bad_alert_body");
  await expectProblem(await post(url, " ".repeat(300 * 1024)), 413, "body_too_large");
});
