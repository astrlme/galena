import { inviteId, invitePreview, memberId, team, workspaceId } from "@galena/contracts";
import { claimInvite, schema } from "@galena/db";
import { linkToken } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { type Triggered, testDeps } from "../test-deps.ts";
import { expectProblem, Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let triggered: Triggered[];
let owner: Session;
let app: ReturnType<typeof createApp>;

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
  expect(setup.status).toBe(201);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

async function invite(by: Session, email: string, role: string, status = 201) {
  const response = await by.call("/v1/invites", { email, role });
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as { id: string; link: string; emailed: boolean };
}

async function teamOf(by: Session) {
  return team.parse(await (await by.call("/v1/team")).json());
}

/** Accepts as a new account, in a browser of its own. */
async function join(link: string, name: string) {
  const person = new Session(app);
  const response = await person.call("/v1/invites/accept", {
    token: tokenOf(link),
    name,
    password: "a long enough password",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return person;
}

test("an invited viewer joins with the link and can read but not change anything", async () => {
  const sent = await invite(owner, "Grace@Example.com", "viewer");
  expect(sent.link).toMatch(/\/invite\/\?token=invite\./);
  expect(sent.emailed).toBe(true);
  expect(triggered).toContainEqual({
    task: "notify.email",
    payload: { kind: "invite", inviteId: sent.id },
    idempotencyKey: `send:invite:${sent.id}`,
  });

  const preview = await app.request(
    `/v1/invites/preview?token=${encodeURIComponent(tokenOf(sent.link))}`,
  );
  expect(invitePreview.parse(await preview.json())).toMatchObject({
    email: "grace@example.com",
    role: "viewer",
    workspaceName: "Acme",
    hasAccount: false,
  });

  const grace = await join(sent.link, "Grace");
  const me = (await (await grace.call("/v1/me")).json()) as { role: string; email: string };
  expect(me).toMatchObject({ role: "viewer", email: "grace@example.com" });
  expect((await grace.call("/v1/monitors")).status).toBe(200);
  await expectProblem(
    await grace.call("/v1/monitors", { name: "Nope", http: { url: "https://example.com/" } }),
    403,
    "forbidden",
  );
  await expectProblem(
    await grace.call("/v1/invites", { email: "x@example.com", role: "viewer" }),
    403,
    "forbidden",
  );

  const { members, invites } = await teamOf(owner);
  expect(members.map((m) => [m.email, m.role, m.isYou])).toEqual([
    ["ada@example.com", "owner", true],
    ["grace@example.com", "viewer", false],
  ]);
  expect(invites).toEqual([]);
});

test("a link works once, only as itself, and only while it's open", async () => {
  const sent = await invite(owner, "linus@example.com", "editor");
  await join(sent.link, "Linus");
  await expectProblem(
    await new Session(app).call("/v1/invites/accept", {
      token: tokenOf(sent.link),
      name: "Again",
      password: "a long enough password",
    }),
    410,
    "invite_closed",
  );

  const forged = `${tokenOf(sent.link).slice(0, -2)}xx`;
  await expectProblem(
    await app.request(`/v1/invites/preview?token=${forged}`),
    404,
    "invite_invalid",
  );

  // Made 49 hours ago: past its 48 hours, refused from the link alone.
  const old = inviteId.parse(v7());
  const issued = new Date(Math.floor((Date.now() - 49 * 3_600_000) / 1000) * 1000);
  const [acme] = await deps.db.select({ id: schema.workspace.id }).from(schema.workspace);
  await deps.db.insert(schema.invite).values({
    id: old,
    workspaceId: workspaceId.parse(acme?.id),
    email: "late@example.com",
    role: "viewer",
    expiresAt: new Date(issued.getTime() + 48 * 3_600_000),
    createdAt: issued,
  });
  const late = linkToken(deps.keys, "invite", old, issued);
  await expectProblem(
    await app.request(`/v1/invites/preview?token=${late}`),
    410,
    "invite_expired",
  );

  // Cancelled, then the link says so.
  const revoked = await invite(owner, "margaret@example.com", "viewer");
  expect((await owner.call(`/v1/invites/${revoked.id}`, undefined, "DELETE")).status).toBe(204);
  await expectProblem(
    await app.request(`/v1/invites/preview?token=${encodeURIComponent(tokenOf(revoked.link))}`),
    410,
    "invite_closed",
  );
});

test("a new invite to the same address replaces the open one, and members can't be invited", async () => {
  const first = await invite(owner, "barbara@example.com", "viewer");
  const second = await invite(owner, "barbara@example.com", "editor");
  await expectProblem(
    await app.request(`/v1/invites/preview?token=${encodeURIComponent(tokenOf(first.link))}`),
    410,
    "invite_closed",
  );
  const { invites } = await teamOf(owner);
  expect(
    invites.filter((i) => i.email === "barbara@example.com").map((i) => [i.id, i.role]),
  ).toEqual([[second.id, "editor"]]);
  await invite(owner, "ada@example.com", "viewer", 409);
});

test("only an owner touches owners, and the last owner stays one", async () => {
  const admin = await join((await invite(owner, "frances@example.com", "admin")).link, "Frances");
  const target = await join((await invite(owner, "radia@example.com", "viewer")).link, "Radia");
  const idOf = async (email: string) =>
    (await teamOf(owner)).members.find((m) => m.email === email)?.id ?? "";
  const ada = await idOf("ada@example.com");

  // An admin manages the team, but not owners.
  expect(
    (
      await admin.call(
        `/v1/members/${await idOf("radia@example.com")}`,
        { role: "editor" },
        "PATCH",
      )
    ).status,
  ).toBe(204);
  await expectProblem(
    await admin.call("/v1/invites", { email: "o@example.com", role: "owner" }),
    403,
    "not_allowed",
  );
  // Nor an owner's invite: an admin can neither cancel it nor replace it with a lesser one.
  const ownerInvite = await invite(owner, "next-owner@example.com", "owner");
  await expectProblem(
    await admin.call(`/v1/invites/${ownerInvite.id}`, undefined, "DELETE"),
    403,
    "not_allowed",
  );
  await expectProblem(
    await admin.call("/v1/invites", { email: "next-owner@example.com", role: "viewer" }),
    403,
    "not_allowed",
  );
  expect((await app.request(`/v1/invites/${ownerInvite.id}/link`)).status).toBe(404);
  await expectProblem(
    await admin.call(`/v1/members/${ada}`, { role: "viewer" }, "PATCH"),
    403,
    "not_allowed",
  );
  await expectProblem(
    await admin.call(`/v1/members/${ada}`, undefined, "DELETE"),
    403,
    "not_allowed",
  );

  // The only owner can be neither demoted nor removed.
  await expectProblem(
    await owner.call(`/v1/members/${ada}`, { role: "admin" }, "PATCH"),
    409,
    "last_owner",
  );
  await expectProblem(
    await owner.call(`/v1/members/${ada}`, undefined, "DELETE"),
    409,
    "last_owner",
  );

  // With a second owner, the first may step down.
  expect(
    (
      await owner.call(
        `/v1/members/${await idOf("frances@example.com")}`,
        { role: "owner" },
        "PATCH",
      )
    ).status,
  ).toBe(204);
  expect((await owner.call(`/v1/members/${ada}`, { role: "admin" }, "PATCH")).status).toBe(204);
  expect((await admin.call(`/v1/members/${ada}`, { role: "owner" }, "PATCH")).status).toBe(204);
  expect((await target.call("/v1/me")).status).toBe(200);
});

test("removing someone signs them out; invited again, they sign in to accept", async () => {
  const sent = await invite(owner, "katherine@example.com", "editor");
  const katherine = await join(sent.link, "Katherine");
  const id =
    (await teamOf(owner)).members.find((m) => m.email === "katherine@example.com")?.id ?? "";
  expect((await owner.call(`/v1/members/${id}`, undefined, "DELETE")).status).toBe(204);
  expect((await katherine.call("/v1/me")).status).toBe(401);
  const audit = await deps.db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetId, id));
  expect(audit.map((a) => a.action).toSorted()).toEqual(["member.created", "member.deleted"]);

  const again = await invite(owner, "katherine@example.com", "viewer");
  const token = tokenOf(again.link);
  const preview = invitePreview.parse(
    await (await app.request(`/v1/invites/preview?token=${encodeURIComponent(token)}`)).json(),
  );
  expect(preview.hasAccount).toBe(true);
  // Someone else holding the link can't take it over: the account must be signed in.
  await expectProblem(
    await new Session(app).call("/v1/invites/accept", { token }),
    409,
    "sign_in_first",
  );
  const back = new Session(app);
  const signIn = await back.call("/auth/sign-in/email", {
    email: "katherine@example.com",
    password: "a long enough password",
  });
  expect(signIn.status).toBe(200);
  expect((await back.call("/v1/invites/accept", { token })).status).toBe(201);
  expect(((await (await back.call("/v1/me")).json()) as { role: string }).role).toBe("viewer");
});

test("two accepts of one invite racing: the second claim changes nothing", async () => {
  const sent = await invite(owner, "edsger@example.com", "viewer");
  await join(sent.link, "Edsger");
  // Someone else's account tries the same, used invite at the database itself.
  await deps.db
    .insert(schema.user)
    .values({ id: "racer", name: "Racer", email: "racer@example.com" });
  const claimed = await deps.db.transaction((tx) =>
    claimInvite(tx, {
      inviteId: inviteId.parse(sent.id),
      userId: "racer",
      memberId: memberId.parse(v7()),
      now: new Date(),
    }),
  );
  expect(claimed).toBeUndefined();
  const { members } = await teamOf(owner);
  expect(members.map((m) => m.email)).not.toContain("racer@example.com");
});
