import { slackInstallationId, type WorkspaceId } from "@galena/contracts";
import { and, eq, ne, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { slackInstallation } from "../schema/index.ts";

export type SlackInstall = {
  teamId: string;
  teamName: string;
  botUserId: string;
  botTokenSealed: string;
  channelId: string;
  channelName: string;
  installedByUserId: string | null;
};
/** `connectedAt` is when it was last installed or reinstalled. */
export type SlackInstallRow = SlackInstall & { workspaceId: WorkspaceId; connectedAt: Date };

const columns = {
  workspaceId: slackInstallation.workspaceId,
  teamId: slackInstallation.teamId,
  teamName: slackInstallation.teamName,
  botUserId: slackInstallation.botUserId,
  botTokenSealed: slackInstallation.botTokenSealed,
  channelId: slackInstallation.channelId,
  channelName: slackInstallation.channelName,
  installedByUserId: slackInstallation.installedByUserId,
  connectedAt: slackInstallation.updatedAt,
};

export function slackRepository(db: Db) {
  return {
    /** Connects the workspace to this Slack team, replacing any other team it had. */
    async save(workspaceId: WorkspaceId, install: SlackInstall): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(slackInstallation)
          .where(
            and(
              eq(slackInstallation.workspaceId, workspaceId),
              ne(slackInstallation.teamId, install.teamId),
            ),
          );
        await tx
          .insert(slackInstallation)
          .values({ id: slackInstallationId.parse(v7()), workspaceId, ...install })
          .onConflictDoUpdate({
            target: slackInstallation.teamId,
            set: { workspaceId, ...install, updatedAt: sql`now()` },
          });
      });
    },

    async findByTeam(teamId: string): Promise<SlackInstallRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(slackInstallation)
        .where(eq(slackInstallation.teamId, teamId))
        .limit(1);
      return row;
    },

    async findByWorkspace(workspaceId: WorkspaceId): Promise<SlackInstallRow | undefined> {
      const [row] = await db
        .select(columns)
        .from(slackInstallation)
        .where(eq(slackInstallation.workspaceId, workspaceId))
        .limit(1);
      return row;
    },

    /** Disconnects; returns what was removed, so its token can be revoked at Slack. */
    async remove(workspaceId: WorkspaceId): Promise<SlackInstallRow | undefined> {
      const [row] = await db
        .delete(slackInstallation)
        .where(eq(slackInstallation.workspaceId, workspaceId))
        .returning(columns);
      return row;
    },

    /** Forgets an install whose token Slack refused, unless it was reinstalled since. */
    async removeRevoked(workspaceId: WorkspaceId, botTokenSealed: string): Promise<boolean> {
      const removed = await db
        .delete(slackInstallation)
        .where(
          and(
            eq(slackInstallation.workspaceId, workspaceId),
            eq(slackInstallation.botTokenSealed, botTokenSealed),
          ),
        )
        .returning({ id: slackInstallation.id });
      return removed.length > 0;
    },
  };
}
