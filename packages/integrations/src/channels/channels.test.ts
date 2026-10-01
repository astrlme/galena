import { componentId, eventId, type Notice } from "@galena/contracts";
import { Webhook } from "standardwebhooks";
import { describe, expect, test } from "vitest";
import { slackMessage } from "./slack.ts";
import { newWebhookSecret, signWebhook, webhookBody } from "./webhook.ts";

const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const incident: Notice = {
  kind: "incident_created",
  eventId: eventId.parse("01920000-0000-7000-8000-000000000901"),
  page: { name: "Acme", url: "https://status.example.com" },
  title: "Errors on <API> & webhooks",
  status: "identified",
  impact: "critical",
  components: [{ id: api, name: "API", status: "major_outage" }],
  body: "We found the cause: a bad deploy.\n\nWe're rolling it back.",
  startsAt: "2026-09-30T10:00:00.000Z",
  endsAt: null,
  occurredAt: "2026-09-30T14:02:00.000Z",
  url: "https://status.example.com/incidents/01920000-0000-7000-8000-000000000101/",
};
const cases: [string, Notice][] = [
  ["created", incident],
  ["updated", { ...incident, kind: "incident_updated", status: "monitoring" }],
  [
    "resolved",
    {
      ...incident,
      kind: "incident_resolved",
      status: "resolved",
      endsAt: "2026-09-30T14:30:00.000Z",
    },
  ],
  [
    "maintenance",
    {
      ...incident,
      kind: "maintenance_scheduled",
      title: "Database upgrade",
      status: "scheduled",
      impact: null,
      components: [{ id: api, name: "API", status: null }],
      body: "Writes pause for up to 5 minutes.",
      startsAt: "2026-10-01T22:00:00.000Z",
      endsAt: "2026-10-01T23:00:00.000Z",
      url: "https://status.example.com/",
    },
  ],
];

describe("slackMessage", () => {
  test.each(cases)("%s matches its snapshot", async (name, notice) => {
    await expect(`${JSON.stringify(slackMessage(notice), null, 2)}\n`).toMatchFileSnapshot(
      `../../test/golden/slack-${name}.json`,
    );
  });

  test("leads with the glyph and state, escapes markup, and keeps buttons unstyled", () => {
    const message = slackMessage(incident);
    const [{ color, blocks }] = message.attachments;
    // The bar takes the state's colour; the words still say it.
    expect(color).toBe("#EF4444");
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "✕︎ Major outage: API" },
    });
    expect(JSON.stringify(message)).toContain("Errors on &lt;API&gt; &amp; webhooks");
    expect(JSON.stringify(message)).not.toContain('"style"');
  });

  test("stays within Slack's limits for a very long update", () => {
    const message = slackMessage({ ...incident, title: "x".repeat(400), body: "y".repeat(10_000) });
    const [{ blocks }] = message.attachments;
    expect(blocks.length).toBeLessThanOrEqual(50);
    const [header, body] = blocks;
    expect(header?.type === "header" && header.text.text.length).toBeLessThanOrEqual(150);
    expect(body?.type === "section" && body.text?.text.length).toBeLessThanOrEqual(3_000);
  });
});

describe("signed webhooks", () => {
  test("verify with the official Standard Webhooks library", () => {
    const secret = newWebhookSecret();
    const body = webhookBody(incident);
    const headers = signWebhook({ id: "msg_1", body, secret, at: new Date() });
    expect(new Webhook(secret).verify(body, headers)).toMatchObject({ type: "incident.created" });
  });

  test("fail verification when the body or the secret differs", () => {
    const secret = newWebhookSecret();
    const body = webhookBody(incident);
    const headers = signWebhook({ id: "msg_1", body, secret, at: new Date() });
    expect(() => new Webhook(secret).verify(`${body} `, headers)).toThrow();
    expect(() => new Webhook(newWebhookSecret()).verify(body, headers)).toThrow();
  });
});
