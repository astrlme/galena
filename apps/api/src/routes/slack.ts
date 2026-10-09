import {
  incidentId,
  type SlackClick,
  type SlackCommandRequest,
  type SlackDecisionAction,
  slackBlockActions,
  slackConnectionView,
  slackDecisionActions,
  slackSlashCommand,
} from "@galena/contracts";
import { slackRepository } from "@galena/db";
import { linkToken, open, readLinkToken, seal } from "@galena/integrations/secrets";
import { verifySlackSignature } from "@galena/integrations/slack";
import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { type App, type Deps, type Env, problemResponse, requireRole } from "../http.ts";
import { json, noContent } from "./shared.ts";

// The Slack app: installing it into a Slack workspace (OAuth), and the requests Slack sends
// when someone presses a button or types /incident. Those two only check Slack's signature and
// hand the work to a task: Slack waits 3 s for an answer, and Aurora can take 15 to resume.

const SCOPES = [
  "chat:write",
  "chat:write.public",
  "commands",
  "users:read",
  "users:read.email",
  "incoming-webhook",
];
const STATE_MAX_AGE_MS = 10 * 60_000;
const settings = (result: "connected" | "cancelled" | "failed") =>
  `/dashboard/settings/?slack=${result}`;

const slackOff = () =>
  problemResponse({
    status: 404,
    code: "slack_off",
    title: "Slack isn't set up",
    detail:
      "Create the Slack app from Galena's manifest, store its secrets in the /galena/<name>/slack-app SecureString, then deploy.",
  });
const unsigned = () =>
  problemResponse({
    status: 401,
    code: "bad_slack_signature",
    title: "Not signed by Slack",
    detail: "The Slack signature didn't match this request, or it is more than 5 minutes old.",
  });

export function registerSlackRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const admin = requireRole(deps, "admin");
  const redirectUri = new URL("/slack/oauth", deps.publicUrl).href;

  /** The raw body when Slack signed it, else undefined. */
  async function signedBody(c: Context<Env>): Promise<string | undefined> {
    if (!deps.slack) return undefined;
    const rawBody = await c.req.text();
    const signed = verifySlackSignature(
      deps.slack.signingSecret,
      {
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
        rawBody,
      },
      new Date(),
    );
    return signed ? rawBody : undefined;
  }

  app.post("/slack/interactions", async (c) => {
    if (!deps.slack) return slackOff();
    const rawBody = await signedBody(c);
    if (rawBody === undefined) return unsigned();
    let payload: unknown;
    try {
      payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "null");
    } catch {
      payload = null;
    }
    // Other interactions (a link button, say) need nothing from Galena.
    const parsed = slackBlockActions.safeParse(payload);
    if (!parsed.success) return c.body(null, 200);
    const { team, user, response_url: responseUrl, actions } = parsed.data;
    for (const action of actions) {
      const decision = slackDecisionActions[action.action_id as SlackDecisionAction];
      const id = incidentId.safeParse(action.value);
      if (!decision || !id.success) continue;
      const click: SlackClick = {
        teamId: team.id,
        userId: user.id,
        userTeamId: user.team_id,
        decision,
        incidentId: id.data,
        responseUrl,
      };
      // One run per press, however often Slack retries the delivery.
      await deps.engine.trigger("slack.interaction", click, {
        idempotencyKey: `slack:${team.id}:${user.id}:${action.action_ts}`,
      });
    }
    return c.body(null, 200);
  });

  app.post("/slack/commands", async (c) => {
    if (!deps.slack) return slackOff();
    const rawBody = await signedBody(c);
    if (rawBody === undefined) return unsigned();
    const parsed = slackSlashCommand.safeParse(Object.fromEntries(new URLSearchParams(rawBody)));
    if (!parsed.success) {
      return c.json({ response_type: "ephemeral", text: "Galena couldn't read that command." });
    }
    const { team_id, user_id, trigger_id, response_url } = parsed.data;
    const request: SlackCommandRequest = {
      teamId: team_id,
      userId: user_id,
      responseUrl: response_url,
    };
    await deps.engine.trigger("slack.command", request, {
      idempotencyKey: `slackcmd:${team_id}:${trigger_id}`,
    });
    return c.json({ response_type: "ephemeral", text: "Looking up open incidents." });
  });

  // Installing: an admin goes to Slack's consent screen, picks the channel for approval cards,
  // and comes back here. `state` ties the answer to that admin for 10 minutes.
  app.get("/slack/install", admin, (c) => {
    if (!deps.slack) return slackOff();
    const state = linkToken(keys, "slack-install", c.get("member").userId, new Date());
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.search = new URLSearchParams({
      client_id: deps.slack.clientId,
      scope: SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
    }).toString();
    return c.redirect(authorize.href, 302);
  });

  app.get("/slack/oauth", admin, async (c) => {
    if (!deps.slack) return slackOff();
    const member = c.get("member");
    const { code, state, error } = c.req.query();
    if (error) return c.redirect(settings("cancelled"), 302);
    const read = state ? readLinkToken(keys, "slack-install", state) : undefined;
    const fresh = read && Date.now() - read.issuedAt.getTime() <= STATE_MAX_AGE_MS;
    if (!code || !read || !fresh || read.id !== member.userId) {
      return c.redirect(settings("failed"), 302);
    }
    const access = await deps.slack.api
      .exchangeCode({
        clientId: deps.slack.clientId,
        clientSecret: deps.slack.clientSecret,
        code,
        redirectUri,
      })
      .catch((failure: unknown) => {
        console.warn("slack.oauth exchange failed", { error: String(failure) });
        return undefined;
      });
    if (!access) return c.redirect(settings("failed"), 302);
    await slackRepository(db).save(member.workspaceId, {
      teamId: access.team.id,
      teamName: access.team.name,
      botUserId: access.bot_user_id,
      botTokenSealed: seal(keys, access.access_token),
      channelId: access.incoming_webhook.channel_id,
      channelName: access.incoming_webhook.channel,
      installedByUserId: member.userId,
    });
    return c.redirect(settings("connected"), 302);
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/slack",
      tags: ["Notifications"],
      summary: "The Slack app's connection",
      description:
        "`available` is false until the deployment has its Slack app's secrets. `connection` names the Slack workspace and the channel approval cards go to.",
      middleware: [admin],
      responses: { 200: json(slackConnectionView, "Whether Slack is set up and connected") },
    }),
    async (c) => {
      const install = await slackRepository(db).findByWorkspace(c.get("member").workspaceId);
      return c.json(
        {
          available: deps.slack !== undefined,
          connection: install
            ? {
                teamName: install.teamName,
                channelName: install.channelName,
                connectedAt: install.connectedAt.toISOString(),
              }
            : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/slack",
      tags: ["Notifications"],
      summary: "Disconnect Slack",
      description: "Forgets the install and revokes its token at Slack.",
      middleware: [admin],
      responses: noContent,
    }),
    async (c) => {
      const removed = await slackRepository(db).remove(c.get("member").workspaceId);
      if (removed && deps.slack) {
        // The row is gone either way; a token Slack fails to revoke is still never used again.
        await deps.slack.api
          .revoke(open(keys, removed.botTokenSealed))
          .catch((failure: unknown) => {
            console.warn("slack.revoke failed", { error: String(failure) });
          });
      }
      return c.body(null, 204);
    },
  );
}
