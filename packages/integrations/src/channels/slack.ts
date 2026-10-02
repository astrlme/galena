import {
  componentStatusLabels,
  incidentImpactLabels,
  incidentStatusLabels,
  maintenanceStatusLabels,
  type Notice,
  noticeParagraphs,
  noticeState,
  noticeStatusLine,
  noticeSubject,
  utcDateTime,
} from "@galena/contracts";
import { embed, stateTokens } from "@galena/ui/tokens";

// A notice as a Slack incoming-webhook message (Block Kit): the header on top, the rest in an
// attachment for the colour bar in the state's colour. Glyph and words still carry the state, and
// the one button has no style (Slack's primary is green, danger red).

type Text = { type: "plain_text" | "mrkdwn"; text: string };
type Block =
  | { type: "header"; text: Text }
  | { type: "section"; text?: Text; fields?: Text[] }
  | { type: "actions"; elements: Array<{ type: "button"; text: Text; url: string }> }
  | { type: "context"; elements: Text[] };
export type SlackMessage = {
  text: string;
  blocks: Block[];
  attachments: [{ color: string; blocks: Block[] }];
};

// Slack's limits: header 150 characters, section text 3,000, field 2,000.
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
// mrkdwn treats these three as markup.
const escapeMrkdwn = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const field = (label: string, value: string): Text => ({
  type: "mrkdwn",
  text: cut(`*${label}*\n${escapeMrkdwn(value)}`, 2_000),
});
const hhmm = (iso: string) => utcDateTime(iso).split(", ")[1] ?? iso;

export function slackMessage(notice: Notice): SlackMessage {
  const maintenance = notice.kind.startsWith("maintenance_");
  const state = noticeState(notice);
  const subject = noticeSubject(notice);
  const components =
    notice.components
      .map((c) => (c.status ? `${c.name} (${componentStatusLabels[c.status]})` : c.name))
      .join(", ") || "None named";
  const fields = maintenance
    ? [
        field(
          "Status",
          maintenanceStatusLabels[notice.status as keyof typeof maintenanceStatusLabels],
        ),
        field("Components", components),
        field("Starts", utcDateTime(notice.startsAt)),
        field("Ends", notice.endsAt ? utcDateTime(notice.endsAt) : "Not set"),
      ]
    : [
        field("Status", incidentStatusLabels[notice.status as keyof typeof incidentStatusLabels]),
        field("Impact", incidentImpactLabels[notice.impact ?? "none"]),
        field("Components", components),
        field("Started", utcDateTime(notice.startsAt)),
      ];
  const body = [
    `*${escapeMrkdwn(notice.title)}*`,
    ...noticeParagraphs(notice).map(escapeMrkdwn),
  ].join("\n\n");
  return {
    // What notifications and screen readers show; with blocks present Slack doesn't print it.
    text: cut(`${subject}. ${noticeStatusLine(notice)}`, 3_000),
    blocks: [{ type: "header", text: { type: "plain_text", text: cut(subject, 150) } }],
    attachments: [
      {
        // Information without a state takes the informational colour.
        color: state ? embed[stateTokens[state]] : embed.degraded,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: cut(body, 3_000) } },
          { type: "section", fields },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: maintenance ? "See the status page" : "Read the incident",
                },
                url: notice.url,
              },
            ],
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Updated ${hhmm(notice.occurredAt)}` }],
          },
        ],
      },
    ],
  };
}
