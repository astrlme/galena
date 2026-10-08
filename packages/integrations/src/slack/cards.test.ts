import { describe, expect, test } from "vitest";
import { approvalCard, type CardIncident, decidedCard, incidentList } from "./cards.ts";

// Golden files: review a diff in test/golden/ like code before updating it (vitest -u).
const golden = (name: string, value: unknown) =>
  expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `../../test/golden/slack-app-${name}.json`,
  );

const draft: CardIncident & { approvalDeadline: string } = {
  id: "01920000-0000-7000-8000-000000000042",
  title: "Checkout is not responding",
  status: "investigating",
  impact: "major",
  components: [{ name: "Checkout", status: "major_outage" }],
  body: "We're seeing timeouts on Checkout from 3 regions. We're investigating & will update by 16:23 UTC.",
  startedAt: "2026-10-08T15:53:00.000Z",
  approvalDeadline: "2026-10-08T16:08:00.000Z",
  url: "https://dashboard.example.com/dashboard/incidents/view/?id=01920000-0000-7000-8000-000000000042",
};
const published: CardIncident = {
  ...draft,
  id: "01920000-0000-7000-8000-000000000041",
  title: "Elevated errors on the API",
  status: "identified",
  components: [{ name: "API", status: "partial_outage" }],
  body: "We found the cause.",
  approvalDeadline: null,
  url: "https://dashboard.example.com/dashboard/incidents/view/?id=01920000-0000-7000-8000-000000000041",
};

describe("approvalCard", () => {
  test("matches its golden file", async () => {
    await golden("approval", approvalCard(draft));
  });

  test("states the deadline and offers both decisions with the incident's id, unstyled", () => {
    const card = approvalCard(draft);
    expect(card.text).toContain(
      "Publishes automatically at 16:08 UTC unless you approve or dismiss it sooner.",
    );
    const [attachment] = card.attachments as [{ blocks: { type: string; elements?: object[] }[] }];
    const buttons = attachment.blocks.find((b) => b.type === "actions")?.elements ?? [];
    expect(buttons).toEqual([
      expect.objectContaining({ action_id: "approve", value: draft.id }),
      expect.objectContaining({ action_id: "dismiss", value: draft.id }),
      expect.objectContaining({ url: draft.url }),
    ]);
    for (const button of buttons) expect(button).not.toHaveProperty("style");
  });

  test("escapes Slack markup in what a person wrote", () => {
    expect(JSON.stringify(approvalCard({ ...draft, title: "<!channel> & co" }))).toContain(
      "&lt;!channel&gt; &amp; co",
    );
  });
});

test("a decided card names who decided and keeps only the dashboard link", async () => {
  const card = decidedCard(draft, {
    action: "approve",
    slackUserId: "U0ADA",
    at: "2026-10-08T15:58:00.000Z",
  });
  await golden("decided", card);
  expect(JSON.stringify(card)).toContain("*Published* by <@U0ADA> at 15:58 UTC.");
  expect(JSON.stringify(card)).not.toContain('"action_id"');
});

describe("incidentList", () => {
  test("matches its golden file: drafts get buttons, published incidents a status line", async () => {
    await golden(
      "list",
      incidentList([draft, published], "https://dashboard.example.com/dashboard/incidents/"),
    );
  });

  test("says when nothing is open", () => {
    expect(incidentList([], "https://d.example.com").text).toBe(
      "Nothing is open: every incident is resolved and no draft is waiting.",
    );
  });

  test("stays under Slack's 50 blocks and points to the dashboard for the rest", () => {
    const many = Array.from({ length: 30 }, (_, k) => ({ ...draft, id: `${k}` }));
    const list = incidentList(many, "https://d.example.com/dashboard/incidents/");
    expect(list.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(list.blocks.at(-1))).toContain("20 more in the dashboard");
  });
});
