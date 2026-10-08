import type { SlackInstallationId } from "@galena/contracts";
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { timestamps } from "./columns.ts";
import { workspaceRef } from "./workspace.ts";

/**
 * The Slack app installed into one Slack workspace. Every request Slack sends names its team,
 * which picks the Galena workspace, so one app can serve many. One install per workspace.
 */
export const slackInstallation = pgTable(
  "slack_installation",
  {
    id: uuid().primaryKey().$type<SlackInstallationId>(),
    workspaceId: workspaceRef(),
    /** Slack's workspace id (`team_id`). */
    teamId: text().notNull(),
    teamName: text().notNull(),
    botUserId: text().notNull(),
    /** The bot's token (`xoxb-…`), sealed with the app key. */
    botTokenSealed: text().notNull(),
    /** Where approval cards go: the channel picked on Slack's consent screen. */
    channelId: text().notNull(),
    channelName: text().notNull(),
    installedByUserId: text().references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.workspaceId),
    uniqueIndex().on(t.teamId),
    index().on(t.installedByUserId),
  ],
);
