import {
  type ComponentStatus,
  componentStatusLabels,
  componentStatusSymbols,
  type IncidentImpact,
  type IncidentStatus,
  incidentImpactLabels,
  incidentStatusLabels,
  pageIndicatorStates,
  type SlackDecisionAction,
  utcDateTime,
} from "@galena/contracts";
import { embed, stateTokens } from "@galena/ui/tokens";
import type { SlackMessage } from "./api.ts";

// The Slack app's own messages (Block Kit): the approval card a draft posts, what replaces it
// once someone decides, and `/incident`'s list. Glyph and words carry each state, the colour bar
// repeats it, and buttons have no `style` (Slack's primary is green, danger red).

/** What a card shows about one incident. */
export type CardIncident = {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  components: { name: string; status: ComponentStatus | null }[];
  /** The newest update's text: for a draft, what would be published. */
  body: string;
  startedAt: string;
  /** Set on a draft a monitor opened: when it publishes on its own. */
  approvalDeadline: string | null;
  /** The incident in the dashboard. */
  url: string;
};

type Text = { type: "plain_text" | "mrkdwn"; text: string };
type Button = { type: "button"; text: Text; action_id?: string; value?: string; url?: string };
type Block =
  | { type: "header"; text: Text }
  | { type: "section"; text?: Text; fields?: Text[] }
  | { type: "actions"; elements: Button[] }
  | { type: "context"; elements: Text[] }
  | { type: "divider" };

// Slack's limits: header 150 characters, section text 3,000, field 2,000, 50 blocks a message.
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const escapeMrkdwn = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const plain = (text: string): Text => ({ type: "plain_text", text });
const mrkdwn = (text: string): Text => ({ type: "mrkdwn", text: cut(text, 3_000) });
const hhmm = (iso: string) => utcDateTime(iso).split(", ")[1] ?? iso;

/** The worst state among the components, or what the impact stands for. */
function stateOf(incident: CardIncident): ComponentStatus | null {
  const order = Object.keys(componentStatusLabels);
  const worst = incident.components
    .flatMap((c) => (c.status ? [c.status] : []))
    .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  if (worst) return worst;
  return incident.impact === "none" ? null : pageIndicatorStates[incident.impact];
}

/** "▲ Partial outage: API", or the title when no component is named. */
function subject(incident: CardIncident): string {
  const state = stateOf(incident);
  const about = incident.components.map((c) => c.name).join(", ") || incident.title;
  return state
    ? `${componentStatusSymbols[state]} ${componentStatusLabels[state]}: ${about}`
    : about;
}

const colour = (incident: CardIncident) => {
  const state = stateOf(incident);
  return state ? embed[stateTokens[state]] : embed.degraded;
};

/** "Publishes automatically at 14:12 UTC unless you approve or dismiss it sooner." */
export const deadlineLine = (deadline: string) =>
  `Publishes automatically at ${hhmm(deadline)} unless you approve or dismiss it sooner.`;

const decisionButtons = (incidentId: string): Button[] => [
  { type: "button", text: plain("Approve and publish"), action_id: "approve", value: incidentId },
  { type: "button", text: plain("Dismiss"), action_id: "dismiss", value: incidentId },
];
const openButton = (incident: CardIncident): Button => ({
  type: "button",
  text: plain("Open in the dashboard"),
  url: incident.url,
});

const fields = (incident: CardIncident): Text[] => [
  mrkdwn(`*Status*\n${incidentStatusLabels[incident.status]}`),
  mrkdwn(`*Impact*\n${incidentImpactLabels[incident.impact]}`),
  mrkdwn(
    `*Components*\n${escapeMrkdwn(incident.components.map((c) => c.name).join(", ") || "None named")}`,
  ),
  mrkdwn(`*Started*\n${utcDateTime(incident.startedAt)}`),
];

function card(incident: CardIncident, lead: string, actions: Button[], text: string): SlackMessage {
  return {
    text: cut(text, 3_000),
    blocks: [{ type: "header", text: plain(cut(subject(incident), 150)) }],
    attachments: [
      {
        color: colour(incident),
        blocks: [
          { type: "section", text: mrkdwn(lead) },
          {
            type: "section",
            text: mrkdwn(`*${escapeMrkdwn(incident.title)}*\n\n${escapeMrkdwn(incident.body)}`),
          },
          { type: "section", fields: fields(incident) },
          { type: "actions", elements: actions },
        ] satisfies Block[],
      },
    ],
  };
}

/** Posted when a monitor opens a draft: Approve and publish, or Dismiss, before the deadline. */
export function approvalCard(draft: CardIncident & { approvalDeadline: string }): SlackMessage {
  const deadline = deadlineLine(draft.approvalDeadline);
  return card(
    draft,
    `*Draft from a monitor.* ${deadline}`,
    [...decisionButtons(draft.id), openButton(draft)],
    `Draft waiting for approval: ${subject(draft)}. ${deadline}`,
  );
}

/** Replaces the approval card once someone in Slack decides it. */
export function decidedCard(
  incident: CardIncident,
  decided: { action: SlackDecisionAction; slackUserId: string; at: string },
): SlackMessage {
  const verb = decided.action === "approve" ? "Published" : "Dismissed";
  const lead = `*${verb}* by <@${decided.slackUserId}> at ${hhmm(decided.at)}.`;
  return card(incident, lead, [openButton(incident)], `${verb}: ${incident.title}`);
}

/** Private answers to a press that changed nothing. */
export const slackRefusals = {
  notMember:
    "Galena doesn't know your Slack email: it doesn't belong to a member of this workspace. Ask an admin to invite it.",
  viewer:
    "Couldn't decide this draft: viewers can't publish or dismiss. Ask an admin for the editor role.",
  decided:
    "This draft was already published or dismissed. Open it in the dashboard to see where it stands.",
  notInstalled:
    "This Slack workspace isn't connected to Galena anymore. Ask an admin to reconnect it.",
} as const;

// Each incident takes three blocks (or four with buttons); this keeps a list under Slack's 50.
const LIST_MAX = 10;

/** `/incident`: what's open and which drafts wait, newest first, visible only to whoever asked. */
export function incidentList(incidents: CardIncident[], dashboardUrl: string): SlackMessage {
  if (incidents.length === 0) {
    const text = "Nothing is open: every incident is resolved and no draft is waiting.";
    return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
  }
  const shown = incidents.slice(0, LIST_MAX);
  const blocks: Block[] = [{ type: "header", text: plain(`Open incidents (${incidents.length})`) }];
  for (const incident of shown) {
    const line = incident.approvalDeadline
      ? `Draft from a monitor. ${deadlineLine(incident.approvalDeadline)}`
      : `${incidentStatusLabels[incident.status]}. ${incidentImpactLabels[incident.impact]}. Started ${utcDateTime(incident.startedAt)}.`;
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: mrkdwn(
          `*<${incident.url}|${escapeMrkdwn(cut(subject(incident), 150))}>*\n${escapeMrkdwn(incident.title)}\n${line}`,
        ),
      },
    );
    if (incident.approvalDeadline) {
      blocks.push({ type: "actions", elements: decisionButtons(incident.id) });
    }
  }
  if (incidents.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [
        mrkdwn(`<${dashboardUrl}|${incidents.length - shown.length} more in the dashboard>`),
      ],
    });
  }
  return { text: `Open incidents: ${incidents.length}`, blocks };
}
