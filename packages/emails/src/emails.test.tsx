import { componentId, eventId, type Notice } from "@galena/contracts";
import { describe, expect, test } from "vitest";
import { confirmationEmail, noticeEmail } from "./index.tsx";

const page = { name: "Acme", url: "https://status.example.com" };
const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const web = componentId.parse("01920000-0000-7000-8000-000000000012");
const unsubscribeUrl = "https://status.example.com/public/unsubscribe?t=unsubscribe.x.1.sig";

const incident: Notice = {
  kind: "incident_created",
  eventId: eventId.parse("01920000-0000-7000-8000-000000000901"),
  page,
  title: "Errors on <API> & webhooks",
  status: "investigating",
  impact: "major",
  components: [
    { id: api, name: "API", status: "partial_outage" },
    { id: web, name: "Web", status: "degraded_performance" },
  ],
  body: "We're seeing errors on API from 3 regions.\n\nWe're investigating and will update by 10:30 UTC.",
  startsAt: "2026-09-30T10:00:00.000Z",
  endsAt: null,
  occurredAt: "2026-09-30T10:02:00.000Z",
  url: "https://status.example.com/incidents/01920000-0000-7000-8000-000000000101/",
};

const cases: [string, Notice][] = [
  ["incident-created", incident],
  [
    "incident-resolved",
    {
      ...incident,
      kind: "incident_resolved",
      status: "resolved",
      components: [{ id: api, name: "API", status: "operational" }],
      body: "API has worked normally since 10:40 UTC.",
      endsAt: "2026-09-30T10:45:00.000Z",
    },
  ],
  [
    "maintenance-scheduled",
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

describe.each(cases)("%s", (name, notice) => {
  test("matches its golden files", async () => {
    const email = await noticeEmail(notice, { unsubscribeUrl });
    await expect(`${email.subject}\n\n${email.text}\n`).toMatchFileSnapshot(
      `../test/golden/${name}.txt`,
    );
    await expect(email.html).toMatchFileSnapshot(`../test/golden/${name}.html`);
  });
});

test("subjects lead with the glyph and the state, then what it is about", async () => {
  const subjects = await Promise.all(
    cases.map(async ([, n]) => (await noticeEmail(n, { unsubscribeUrl })).subject),
  );
  expect(subjects).toEqual([
    "▲︎ Partial outage: API, Web",
    "✓︎ Resolved: API",
    "◌︎ Maintenance scheduled: Database upgrade",
  ]);
});

test("titles and updates are escaped in the HTML", async () => {
  const { html } = await noticeEmail(incident, { unsubscribeUrl });
  expect(html).toContain("Errors on &lt;API&gt; &amp; webhooks");
  expect(html).not.toContain("<API>");
});

test("every notice links to the page and to one-click unsubscribe, in both parts", async () => {
  for (const [, notice] of cases) {
    const email = await noticeEmail(notice, { unsubscribeUrl });
    for (const part of [email.html, email.text]) {
      expect(part).toContain(notice.url);
      expect(part).toContain(unsubscribeUrl.replaceAll("&", part === email.html ? "&amp;" : "&"));
    }
  }
});

test("the confirmation email carries the link and says how long it works", async () => {
  const confirmUrl = "https://status.example.com/public/confirm?t=confirm.x.1.sig";
  const email = await confirmationEmail({ page, confirmUrl });
  await expect(`${email.subject}\n\n${email.text}\n`).toMatchFileSnapshot(
    "../test/golden/confirmation.txt",
  );
  await expect(email.html).toMatchFileSnapshot("../test/golden/confirmation.html");
  expect(email.html).toContain(confirmUrl);
  expect(email.text).toContain("7 days");
});
