import { expect, test } from "vitest";
import { snapshot } from "./snapshot.ts";

const published = {
  version: 1,
  snapshotVersion: 1,
  publishedAt: "2026-10-08T12:00:00.000Z",
  page: { slug: "status", name: "Acme", url: "https://status.example.com" },
  indicator: "none",
  groups: [],
  components: [],
  incidents: { active: [], recent: [] },
  maintenance: { active: [], upcoming: [] },
};

test("a snapshot published before pages could turn subscriptions off still offers them", () => {
  expect(snapshot.parse(published).page.subscribe).toBe(true);
});

test("a page without email offers no subscriptions", () => {
  const page = { ...published.page, subscribe: false };
  expect(snapshot.parse({ ...published, page }).page.subscribe).toBe(false);
});
