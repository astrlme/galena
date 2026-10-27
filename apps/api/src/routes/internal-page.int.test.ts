import { generateKeyPairSync } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { TEST_BASE_URL, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let owner: Session;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const decode = (value: string) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64").toString();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = { ...built.deps, pageAccess: { keyPairId: "K2JCJMDEHXQW5F", privateKey } };
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

test("a signed-in member gets 12 hours on the internal page, and signing out ends them", async () => {
  const before = Date.now();
  const response = await owner.call("/v1/internal-page/access", {});
  expect(response.status).toBe(204);
  const cookies = new Map(
    response.headers.getSetCookie().map((header) => {
      const [pair = "", ...attributes] = header.split("; ");
      const at = pair.indexOf("=");
      return [pair.slice(0, at), { value: pair.slice(at + 1), attributes }] as const;
    }),
  );
  expect([...cookies.keys()]).toEqual([
    "CloudFront-Policy",
    "CloudFront-Signature",
    "CloudFront-Key-Pair-Id",
    "CloudFront-Hash-Algorithm",
  ]);
  // Only the internal page's path gets them, never a script, and they go along with a link
  // from Slack or an email.
  for (const { attributes } of cookies.values()) {
    expect(attributes.sort()).toEqual(["HttpOnly", "Path=/internal", "SameSite=Lax", "Secure"]);
  }
  const policy = JSON.parse(decode(cookies.get("CloudFront-Policy")?.value ?? ""));
  const statement = policy.Statement[0];
  expect(statement.Resource).toBe(`${TEST_BASE_URL}/internal*`);
  const expires = statement.Condition.DateLessThan["AWS:EpochTime"] * 1000;
  expect(expires - before).toBeGreaterThan(12 * 3_600_000 - 5_000);
  expect(expires - before).toBeLessThanOrEqual(12 * 3_600_000 + 5_000);

  const signOut = await owner.call("/auth/sign-out", {});
  expect(signOut.status).toBe(200);
  const cleared = signOut.headers.getSetCookie().filter((h) => h.startsWith("CloudFront-"));
  expect(cleared).toHaveLength(4);
  for (const header of cleared)
    expect(header).toMatch(/Max-Age=0.*Path=\/internal|Path=\/internal.*Max-Age=0/);
});

test("nobody signed out gets them, and a deployment without a signing key says so", async () => {
  const stranger = new Session(createApp(deps));
  await expectProblem(await stranger.call("/v1/internal-page/access", {}), 401, "unauthenticated");

  const { pageAccess: _, ...withoutKey } = deps;
  const member = new Session(createApp(withoutKey));
  const signIn = await member.call("/auth/sign-in/email", {
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(signIn.status).toBe(200);
  await expectProblem(await member.call("/v1/internal-page/access", {}), 503, "internal_page_off");
});
