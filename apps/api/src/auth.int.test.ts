import { createHmac } from "node:crypto";
import { problemDetails } from "@galena/contracts";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp, type Deps, requireRole } from "./app.ts";
import { TEST_BASE_URL, testDeps } from "./test-deps.ts";

const OWNER = { name: "Ada", email: "ada@example.com", password: "correct horse battery" };

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let app: ReturnType<typeof createApp>;
// Signed in by first-run setup; its session outlives the two-factor change below.
let owner: Session;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  close = built.close;
  app = createApp(deps);
  app.use("/v1/admin-probe", requireRole(deps, "admin"));
  app.get("/v1/admin-probe", (c) => c.json({ ok: true }));
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

/** Remembers cookies between requests, like a browser. */
class Session {
  #cookies = new Map<string, string>();

  async call(path: string, body?: unknown): Promise<Response> {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: TEST_BASE_URL,
        "content-type": "application/json",
        cookie: [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (value === "" || /max-age=0/i.test(header)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }
}

/** RFC 6238 TOTP for an otpauth:// URI, so the test signs in the way an authenticator app does. */
function totp(uri: string, at = Date.now()): string {
  const params = new URL(uri).searchParams;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...(params.get("secret") ?? "").replace(/=+$/, "").toUpperCase()]
    .map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / Number(params.get("period") ?? 30))));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const digits = Number(params.get("digits") ?? 6);
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(problemDetails.parse(await response.json())).toMatchObject({ status, code });
}

describe("sign-up", () => {
  test("first-run setup creates the workspace and signs the owner in", async () => {
    owner = new Session();
    const response = await owner.call("/v1/setup", { workspaceName: "Acme", ...OWNER });
    expect(response.status).toBe(201);
    const me = await owner.call("/v1/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: OWNER.email, role: "owner" });
  });

  test("setup works only once", async () => {
    await expectProblem(
      await new Session().call("/v1/setup", {
        workspaceName: "Other",
        name: "Eve",
        email: "eve@example.com",
        password: "another long password",
      }),
      409,
      "already_set_up",
    );
  });

  test("sign-up is closed once the workspace exists", async () => {
    const response = await new Session().call("/auth/sign-up/email", {
      name: "Eve",
      email: "eve@example.com",
      password: "another long password",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Sign-up is closed");
  });

  test("setup rejects a password shorter than 12 characters", async () => {
    await expectProblem(
      await new Session().call("/v1/setup", { workspaceName: "X", ...OWNER, password: "short" }),
      400,
      "validation_failed",
    );
  });
});

describe("sign-in", () => {
  test("a wrong password is refused and the right one signs in", async () => {
    const browser = new Session();
    const wrong = await browser.call("/auth/sign-in/email", {
      ...OWNER,
      password: "not the password",
    });
    expect(wrong.status).toBe(401);
    await expectProblem(await browser.call("/v1/me"), 401, "unauthenticated");

    const right = await browser.call("/auth/sign-in/email", OWNER);
    expect(right.status).toBe(200);
    expect((await browser.call("/v1/me")).status).toBe(200);
  });
});

describe("two-factor", () => {
  test("once enabled, sign-in needs a TOTP code before there is a session", async () => {
    const enable = await owner.call("/auth/two-factor/enable", { password: OWNER.password });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(backupCodes.length).toBeGreaterThan(0);
    const confirm = await owner.call("/auth/two-factor/verify-totp", { code: totp(totpURI) });
    expect(confirm.status).toBe(200);

    const browser = new Session();
    const signIn = await browser.call("/auth/sign-in/email", OWNER);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    await expectProblem(await browser.call("/v1/me"), 401, "unauthenticated");

    const wrong = await browser.call("/auth/two-factor/verify-totp", { code: "000000" });
    expect(wrong.ok).toBe(false);
    // The next period's code: a code already used above may be refused as a replay.
    const code = totp(totpURI, Date.now() + 30_000);
    const verify = await browser.call("/auth/two-factor/verify-totp", { code });
    expect(verify.status).toBe(200);
    expect((await browser.call("/v1/me")).status).toBe(200);
  });
});

describe("roles", () => {
  test("a member below the required role is refused, and nobody signed out gets in", async () => {
    await expectProblem(await new Session().call("/v1/admin-probe"), 401, "unauthenticated");
    expect((await owner.call("/v1/admin-probe")).status).toBe(200);

    const [account] = await deps.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, OWNER.email));
    await deps.db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(eq(schema.member.userId, account?.id ?? ""));
    await expectProblem(await owner.call("/v1/admin-probe"), 403, "forbidden");
    expect((await owner.call("/v1/me")).status).toBe(200); // viewers may still read
  });
});
