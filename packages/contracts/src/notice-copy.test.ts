import { expect, test } from "vitest";
import { noticeState, noticeSubject } from "./notice-copy.ts";
import type { Notice } from "./notifications.ts";

const base: Notice = {
  kind: "incident_created",
  eventId: "01920000-0000-7000-8000-000000000901" as Notice["eventId"],
  page: { name: "Acme", url: "https://status.example.com" },
  title: "DNS change tonight",
  status: "investigating",
  impact: "none",
  components: [],
  body: "Nothing should break.",
  startsAt: "2026-10-01T10:00:00.000Z",
  endsAt: null,
  occurredAt: "2026-10-01T10:00:00.000Z",
  url: "https://status.example.com/incidents/x/",
};

test("an open incident with no impact is information, not operational", () => {
  expect(noticeState(base)).toBeNull();
  expect(noticeSubject(base)).toBe("Update: DNS change tonight");
});

test("otherwise the worst component state, or what the impact stands for, leads", () => {
  expect(noticeState({ ...base, impact: "major" })).toBe("partial_outage");
  const api = { id: base.eventId as never, name: "API", status: "major_outage" as const };
  expect(noticeState({ ...base, components: [api] })).toBe("major_outage");
  expect(noticeState({ ...base, kind: "incident_resolved" })).toBe("operational");
  expect(noticeState({ ...base, kind: "maintenance_started" })).toBe("under_maintenance");
});
