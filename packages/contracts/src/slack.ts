import { z } from "zod";
import { incidentId } from "./ids.ts";

// Slack's own shapes, parsed where they arrive: the API's /slack routes and the Web API's
// answers. Only the fields Galena reads; Slack sends many more.

const slackId = z.string().regex(/^[A-Z0-9]+$/);
// Slack signs the payload, but a response URL still has to be its own.
const responseUrl = z.url({ protocol: /^https$/, hostname: /^hooks\.slack\.com$/ });

/** The two buttons on an approval card; each carries the incident's id as its value. */
export const slackDecisionActions = { approve: "publish", dismiss: "dismiss" } as const;
export type SlackDecisionAction = keyof typeof slackDecisionActions;

/** A button press (`block_actions`), from the `payload` form field Slack posts. */
export const slackBlockActions = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: slackId }),
  user: z.object({ id: slackId }),
  response_url: responseUrl,
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string().optional(), action_ts: z.string() }))
    .min(1),
});

/** A slash command, as the form fields Slack posts. */
export const slackSlashCommand = z.object({
  command: z.string(),
  team_id: slackId,
  user_id: slackId,
  response_url: responseUrl,
  text: z.string().default(""),
});

/** What the API hands `slack.interaction`: one press of Approve or Dismiss. */
export const slackClick = z.object({
  teamId: slackId,
  userId: slackId,
  decision: z.enum(["publish", "dismiss"]),
  incidentId,
  responseUrl,
});
export type SlackClick = z.infer<typeof slackClick>;

/** What the API hands `slack.command`: one `/incident`. */
export const slackCommandRequest = z.object({ teamId: slackId, userId: slackId, responseUrl });
export type SlackCommandRequest = z.infer<typeof slackCommandRequest>;

/** `oauth.v2.access`: the bot's token, its Slack workspace and the channel picked on install. */
export const slackOAuthAccess = z.object({
  access_token: z.string().startsWith("xoxb-"),
  bot_user_id: slackId,
  team: z.object({ id: slackId, name: z.string() }),
  incoming_webhook: z.object({ channel: z.string(), channel_id: slackId }),
});
export type SlackOAuthAccess = z.infer<typeof slackOAuthAccess>;

/** `users.info`: whether the person is real, and their verified email. */
export const slackUserInfo = z.object({
  user: z.object({
    deleted: z.boolean().optional(),
    is_bot: z.boolean().optional(),
    profile: z.object({ email: z.email().optional() }),
  }),
});

/** `chat.postMessage`: where the message went. */
export const slackPosted = z.object({ channel: slackId, ts: z.string() });

/** `auth.revoke`. */
export const slackRevoked = z.object({ revoked: z.boolean() });
