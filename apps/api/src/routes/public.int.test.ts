import { schema } from "@galena/db";
import { linkToken } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type Triggered, testDeps } from "../test-deps.ts";
import { Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let app: ReturnType<typeof createApp>;
let api: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  triggered = built.triggered;
  close = built.close;
  app = createApp(deps);
  const owner = new Session(app);
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

const form = (fields: Record<string, string | string[]>, ip = "203.0.113.7") => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
  return {
    method: "POST",
    body,
    headers: { "cloudfront-viewer-address": `${ip}:44321` },
  };
};
const subscriber = async (email: string) =>
  (await deps.db.select().from(schema.subscriber).where(eq(schema.subscriber.email, email)))[0];
const requests = async () =>
  (await deps.db.select().from(schema.outbox)).filter(
    (r) => r.eventType === "subscriber.requested",
  );

test("the form subscribes an address pending confirmation and asks for one email", async () => {
  const res = await app.request(
    "/public/subscribe",
    form({ email: "Grace@Example.com", component: api }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/subscription/sent/");
  expect(await subscriber("grace@example.com")).toMatchObject({
    state: "pending_confirmation",
    componentIds: [api],
  });
  expect(await requests()).toHaveLength(1);
  expect(triggered.at(-1)?.task).toBe("outbox.dispatch");

  // Sent again at once (a double click, or someone else): the same answer, no second email.
  const again = await app.request("/public/subscribe", form({ email: "grace@example.com" }));
  expect(again.headers.get("location")).toBe("/subscription/sent/");
  expect(await requests()).toHaveLength(1);
});

test("the page's script gets JSON, and a bad address is refused either way", async () => {
  const ok = await app.request("/public/subscribe", {
    ...form({ email: "linus@example.com" }),
    headers: { accept: "application/json" },
  });
  expect([ok.status, await ok.json()]).toEqual([202, { status: "check_inbox" }]);
  const bad = await app.request("/public/subscribe", form({ email: "not an address" }));
  expect(bad.headers.get("location")).toBe("/subscription/bad-address/");
});

test("one network can submit only so many addresses an hour", async () => {
  for (let i = 0; i < 12; i++) {
    const res = await app.request(
      "/public/subscribe",
      form({ email: `bulk${i}@example.com` }, "198.51.100.9"),
    );
    expect(res.headers.get("location")).toBe("/subscription/sent/");
  }
  expect(await subscriber("bulk9@example.com")).toBeDefined();
  expect(await subscriber("bulk10@example.com")).toBeUndefined();
});

test("a confirmation link activates once and keeps working; an old or edited one does not", async () => {
  const row = await subscriber("grace@example.com");
  if (!row) throw new Error("no subscriber");
  const confirm = (t: string) => app.request(`/public/confirm?t=${encodeURIComponent(t)}`);
  const fresh = linkToken(deps.keys, "confirm", row.id, new Date());
  for (let i = 0; i < 2; i++) {
    expect((await confirm(fresh)).headers.get("location")).toBe("/subscription/confirmed/");
  }
  expect((await subscriber("grace@example.com"))?.state).toBe("active");

  const old = linkToken(deps.keys, "confirm", row.id, new Date(Date.now() - 8 * 86_400_000));
  const pending = await subscriber("linus@example.com");
  const edited = linkToken(deps.keys, "confirm", row.id, new Date()).replace(
    row.id,
    pending?.id ?? "",
  );
  for (const t of [old, edited, "junk"]) {
    expect((await confirm(t)).headers.get("location")).toBe("/subscription/bad-link/");
  }
  expect((await subscriber("linus@example.com"))?.state).toBe("pending_confirmation");
});

test("unsubscribes from the page's form and from a mail app's one-click post", async () => {
  const grace = await subscriber("grace@example.com");
  const linus = await subscriber("linus@example.com");
  if (!grace || !linus) throw new Error("no subscribers");
  const byForm = await app.request(
    "/public/unsubscribe",
    form({ t: linkToken(deps.keys, "unsubscribe", grace.id, new Date()) }),
  );
  expect(byForm.headers.get("location")).toBe("/subscription/unsubscribed/");
  expect((await subscriber("grace@example.com"))?.state).toBe("unsubscribed");

  const t = encodeURIComponent(linkToken(deps.keys, "unsubscribe", linus.id, new Date()));
  const oneClick = await app.request(
    `/public/unsubscribe?t=${t}`,
    form({ "List-Unsubscribe": "One-Click" }),
  );
  expect(oneClick.status).toBe(200);
  expect((await subscriber("linus@example.com"))?.state).toBe("unsubscribed");

  const forged = await app.request(
    "/public/unsubscribe?t=unsubscribe.x.1.y",
    form({ "List-Unsubscribe": "One-Click" }),
  );
  expect(forged.status).toBe(400);
});
