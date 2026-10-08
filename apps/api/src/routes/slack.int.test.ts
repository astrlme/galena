import { createHmac } from "node:crypto";
import type { SlackOAuthAccess } from "@galena/contracts";
import { schema } from "@galena/db";
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
let app: ReturnType<typeof createApp>;
let owner: Session;

const signingSecret = "slack-signing-secret-for-tests";
const revoked: string[] = [];
let access: SlackOAuthAccess | Error = {
  access_token: "xoxb-1-2-abc",
  bot_user_id: "U0BOT",
  team: { id: "T0ACME", name: "Acme Slack" },
  incoming_webhook: { channel: "#incidents", channel_id: "C0INC" },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = {
    ...built.deps,
    slack: {
      clientId: "1234.5678",
      clientSecret: "client-secret",
      signingSecret,
      api: {
        exchangeCode: async () => {
          if (access instanceof Error) throw access;
          return access;
        },
        revoke: async (token) => {
          revoked.push(token);
          return { revoked: true };
        },
      },
    },
  };
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

/** A request as Slack signs it: form-encoded, `v0` HMAC over timestamp and body. */
function fromSlack(path: string, form: Record<string, string>, at = new Date()) {
  const body = new URLSearchParams(form).toString();
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return app.request(path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
  });
}
const incident = v7();
const press = (actionId: string, value = incident) => ({
  payload: JSON.stringify({
    type: "block_actions",
    team: { id: "T0ACME" },
    user: { id: "U0ADA" },
    response_url: "https://hooks.slack.com/actions/T0ACME/1/abc",
    actions: [{ action_id: actionId, value, action_ts: "1728390000.123456" }],
  }),
});

test("Slack's routes answer 404 until the deployment has the app's secrets", async () => {
  const { slack: _, ...without } = deps;
  const off = createApp(without);
  await expectProblem(
    await off.request("/slack/interactions", { method: "POST" }),
    404,
    "slack_off",
  );
});

test("a press of Approve becomes one slack.interaction run, keyed by the press", async () => {
  const before = triggered.length;
  const res = await fromSlack("/slack/interactions", press("approve"));
  expect(res.status).toBe(200);
  expect(triggered.slice(before)).toEqual([
    {
      task: "slack.interaction",
      payload: {
        teamId: "T0ACME",
        userId: "U0ADA",
        decision: "publish",
        incidentId: incident,
        responseUrl: "https://hooks.slack.com/actions/T0ACME/1/abc",
      },
      idempotencyKey: "slack:T0ACME:U0ADA:1728390000.123456",
    },
  ]);
});

test("a link button or a stray value is acknowledged and starts nothing", async () => {
  const before = triggered.length;
  expect((await fromSlack("/slack/interactions", press("open-dashboard"))).status).toBe(200);
  expect((await fromSlack("/slack/interactions", press("approve", "not-an-id"))).status).toBe(200);
  expect(triggered.length).toBe(before);
});

test("refuses a request Slack didn't sign, or signed more than five minutes ago", async () => {
  const before = triggered.length;
  const forged = await app.request("/slack/interactions", {
    method: "POST",
    body: new URLSearchParams(press("approve")).toString(),
    headers: { "x-slack-request-timestamp": "1", "x-slack-signature": "v0=00" },
  });
  await expectProblem(forged, 401, "bad_slack_signature");
  const old = await fromSlack(
    "/slack/interactions",
    press("approve"),
    new Date(Date.now() - 6 * 60_000),
  );
  await expectProblem(old, 401, "bad_slack_signature");
  expect(triggered.length).toBe(before);
});

test("/incident answers at once and hands the lookup to slack.command", async () => {
  const before = triggered.length;
  const res = await fromSlack("/slack/commands", {
    command: "/incident",
    team_id: "T0ACME",
    user_id: "U0ADA",
    trigger_id: "13345224609.738474920.8088930838d88f008e0",
    response_url: "https://hooks.slack.com/commands/T0ACME/1/abc",
    text: "",
  });
  expect(await res.json()).toEqual({
    response_type: "ephemeral",
    text: "Looking up open incidents.",
  });
  expect(triggered.slice(before)).toEqual([
    {
      task: "slack.command",
      payload: {
        teamId: "T0ACME",
        userId: "U0ADA",
        responseUrl: "https://hooks.slack.com/commands/T0ACME/1/abc",
      },
      idempotencyKey: "slackcmd:T0ACME:13345224609.738474920.8088930838d88f008e0",
    },
  ]);
});

/** Starts an install as the signed-in admin and returns the `state` Slack would send back. */
async function startInstall(): Promise<string> {
  const res = await owner.call("/slack/install");
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: "1234.5678",
    scope: "chat:write,chat:write.public,commands,users:read,users:read.email,incoming-webhook",
    redirect_uri: "http://localhost:8787/slack/oauth",
  });
  return authorize.searchParams.get("state") ?? "";
}

test("an admin connects Slack: the token is stored sealed and Settings shows the channel", async () => {
  expect(await (await owner.call("/v1/slack")).json()).toEqual({
    available: true,
    connection: null,
  });
  const state = await startInstall();
  const back = await owner.call(`/slack/oauth?code=c0de&state=${encodeURIComponent(state)}`);
  expect(back.headers.get("location")).toBe("/dashboard/settings/?slack=connected");
  expect(await (await owner.call("/v1/slack")).json()).toMatchObject({
    available: true,
    connection: { teamName: "Acme Slack", channelName: "#incidents" },
  });
  const [row] = await deps.db.select().from(schema.slackInstallation);
  expect(row?.botTokenSealed).not.toContain("xoxb");
});

test("an install comes back failed with a forged state or a refused code, cancelled when declined", async () => {
  const failed = "/dashboard/settings/?slack=failed";
  expect((await owner.call("/slack/oauth?code=c0de&state=forged")).headers.get("location")).toBe(
    failed,
  );
  expect((await owner.call("/slack/oauth?error=access_denied")).headers.get("location")).toBe(
    "/dashboard/settings/?slack=cancelled",
  );
  access = new Error("invalid_code");
  const state = await startInstall();
  expect(
    (await owner.call(`/slack/oauth?code=bad&state=${encodeURIComponent(state)}`)).headers.get(
      "location",
    ),
  ).toBe(failed);
});

test("disconnecting forgets the install and revokes its token", async () => {
  expect((await owner.call("/v1/slack", undefined, "DELETE")).status).toBe(204);
  expect(revoked).toEqual(["xoxb-1-2-abc"]);
  expect(await (await owner.call("/v1/slack")).json()).toEqual({
    available: true,
    connection: null,
  });
});

test("only admins may install, see or disconnect Slack", async () => {
  await deps.db
    .update(schema.member)
    .set({ role: "editor" })
    .where(eq(schema.member.role, "owner"));
  await expectProblem(await owner.call("/v1/slack"), 403, "forbidden");
  await expectProblem(await owner.call("/slack/install"), 403, "forbidden");
  await expectProblem(await owner.call("/v1/slack", undefined, "DELETE"), 403, "forbidden");
});
