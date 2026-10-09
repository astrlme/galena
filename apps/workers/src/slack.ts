import {
  type IncidentId,
  incidentId,
  type OutboxId,
  type SlackClick,
  type SlackCommandRequest,
  type WorkspaceId,
  workspaceId,
} from "@galena/contracts";
import { type Clock, type Incident, roleAtLeast } from "@galena/core";
import {
  componentRepository,
  type Db,
  findMemberByEmail,
  incidentRepository,
  type SlackInstallRow,
  slackRepository,
} from "@galena/db";
import { type AppKeys, open } from "@galena/integrations/secrets";
import {
  approvalCard,
  type CardIncident,
  decidedCard,
  incidentList,
  type SlackApi,
  slackRefusals,
} from "@galena/integrations/slack";
import { z } from "zod";
import { type DraftAnswer, decideDraft } from "./autopilot.ts";

// The Slack app's side of approvals: posting a draft's card, answering a press of Approve or
// Dismiss, and `/incident`. The API only checked Slack's signature; everything that needs the
// database or the bot's token happens here.

/** What `slack.approval-card` posts about: one draft a monitor opened. */
export const cardPayload = z.object({ workspaceId, incidentId });
export type CardPayload = z.infer<typeof cardPayload>;

export type SlackDeps = {
  db: Db;
  keys: AppKeys;
  clock: Clock;
  api: Pick<SlackApi, "postMessage" | "userEmail" | "respond">;
  /** The dashboard's origin, for links. */
  dashboardUrl: string;
  /** Hands a committed outbox row to `outbox.dispatch`. */
  dispatch: (outboxId: OutboxId) => Promise<void>;
  /** Wakes the draft's approval run with the answer. */
  completeToken: (tokenId: string, answer: DraftAnswer) => Promise<void>;
};

/** One incident as the cards show it, with component names and a dashboard link. */
async function toCard(
  db: Db,
  incident: Incident & { updates?: { body: string }[] },
  dashboardUrl: string,
): Promise<CardIncident> {
  const names = new Map(
    (await componentRepository(db).listByWorkspace(incident.workspaceId)).map((c) => [
      c.id,
      c.name,
    ]),
  );
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    components: incident.components.map((c) => ({
      name: names.get(c.componentId) ?? "A removed component",
      status: c.status,
    })),
    body: incident.updates?.[0]?.body ?? "",
    startedAt: incident.startedAt.toISOString(),
    approvalDeadline:
      incident.visibility === "draft" ? (incident.approvalDeadline?.toISOString() ?? null) : null,
    url: new URL(`/dashboard/incidents/view/?id=${incident.id}`, dashboardUrl).href,
  };
}

async function draftCard(
  deps: SlackDeps,
  workspace: WorkspaceId,
  id: IncidentId,
): Promise<CardIncident | undefined> {
  const incident = await incidentRepository(deps.db).findById(workspace, id);
  return incident ? toCard(deps.db, incident, deps.dashboardUrl) : undefined;
}

/** Posts the draft's approval card to the channel picked on install. */
export async function postApprovalCard(
  { workspaceId: workspace, incidentId: id }: CardPayload,
  deps: SlackDeps,
): Promise<"posted" | "no_install" | "not_a_draft"> {
  const install = await slackRepository(deps.db).findByWorkspace(workspace);
  if (!install) return "no_install";
  const card = await draftCard(deps, workspace, id);
  if (!card?.approvalDeadline) return "not_a_draft";
  await deps.api.postMessage(
    open(deps.keys, install.botTokenSealed),
    install.channelId,
    approvalCard({ ...card, approvalDeadline: card.approvalDeadline }),
  );
  return "posted";
}

/** The Galena member behind a Slack user, matched by their verified email. */
async function memberOf(deps: SlackDeps, install: SlackInstallRow, slackUserId: string) {
  const email = await deps.api.userEmail(open(deps.keys, install.botTokenSealed), slackUserId);
  return email ? findMemberByEmail(deps.db, install.workspaceId, email) : undefined;
}

const privately = (text: string) => ({
  text,
  blocks: [],
  response_type: "ephemeral" as const,
  replace_original: false,
});

/** A press of Approve or Dismiss: decides the draft as that member, or says privately why not. */
export async function answerClick(click: SlackClick, deps: SlackDeps) {
  const reply = (text: string) => deps.api.respond(click.responseUrl, privately(text));
  const install = await slackRepository(deps.db).findByTeam(click.teamId);
  if (!install) {
    await reply(slackRefusals.notInstalled);
    return "not_installed" as const;
  }
  // Someone from another organisation's Slack has an email their own admin controls.
  if (click.userTeamId !== install.teamId) {
    await reply(slackRefusals.otherTeam);
    return "other_team" as const;
  }
  const member = await memberOf(deps, install, click.userId);
  if (!member) {
    await reply(slackRefusals.notMember);
    return "not_a_member" as const;
  }
  if (!roleAtLeast(member.role, "editor")) {
    await reply(slackRefusals.viewer);
    return "viewer" as const;
  }
  const workspace = install.workspaceId;
  const visibility = click.decision === "publish" ? "published" : "dismissed";
  const decided = await decideDraft(
    {
      workspaceId: workspace,
      incidentId: click.incidentId,
      visibility,
      actorUserId: member.userId,
    },
    deps,
  );
  if (!decided) {
    await reply(slackRefusals.decided);
    return "already_decided" as const;
  }
  // The decision is committed. What follows only saves time and tidies the card, so a failure
  // is logged, not retried: a retry would find the draft decided and say so to the person.
  const tokenId = await incidentRepository(deps.db).findApprovalToken(workspace, click.incidentId);
  const answer: DraftAnswer = { decision: click.decision === "publish" ? "approve" : "dismiss" };
  await Promise.allSettled([
    tokenId ? deps.completeToken(tokenId, answer) : Promise.resolve(),
    draftCard(deps, workspace, click.incidentId).then((card) =>
      card
        ? deps.api.respond(click.responseUrl, {
            ...decidedCard(card, {
              action: answer.decision,
              slackUserId: click.userId,
              at: deps.clock.now().toISOString(),
            }),
            replace_original: true,
          })
        : undefined,
    ),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("slack.interaction follow-up failed", { error: String(result.reason) });
      }
    }
  });
  return visibility;
}

/** `/incident`: open incidents and waiting drafts, for members only, visible to the asker. */
export async function answerCommand(request: SlackCommandRequest, deps: SlackDeps) {
  const reply = (text: string) => deps.api.respond(request.responseUrl, privately(text));
  const install = await slackRepository(deps.db).findByTeam(request.teamId);
  if (!install) {
    await reply(slackRefusals.notInstalled);
    return "not_installed" as const;
  }
  if (!(await memberOf(deps, install, request.userId))) {
    await reply(slackRefusals.notMember);
    return "not_a_member" as const;
  }
  const incidents = await incidentRepository(deps.db).list(install.workspaceId, { open: true });
  const cards = await Promise.all(incidents.map((i) => toCard(deps.db, i, deps.dashboardUrl)));
  await deps.api.respond(request.responseUrl, {
    ...incidentList(cards, new URL("/dashboard/incidents/", deps.dashboardUrl).href),
    response_type: "ephemeral",
  });
  return "listed" as const;
}
