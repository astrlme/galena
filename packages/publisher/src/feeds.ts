import type { Snapshot, SnapshotIncident } from "@galena/contracts";
import { xml } from "./glyphs.ts";

// RSS 2.0 and Atom feeds of the page's incidents: open ones, then those resolved recently.
// One entry per incident, dated by its latest update, so readers see it again when it moves.

const STATUS: Record<SnapshotIncident["status"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  postmortem: "Postmortem",
};

const incidents = (s: Snapshot) => [...s.incidents.active, ...s.incidents.recent];
const pageLink = (s: Snapshot, path = "") => `${s.page.url.replace(/\/$/, "")}/${path}`;
const incidentLink = (s: Snapshot, i: SnapshotIncident) => pageLink(s, `incidents/${i.id}/`);
/** Every update, newest first, as plain text: the feed never carries HTML. */
const summary = (i: SnapshotIncident) =>
  i.updates.map((u) => `${STATUS[u.status]}: ${u.body}`).join("\n\n");

export function rssFeed(s: Snapshot): string {
  const items = incidents(s).map((i) =>
    [
      "<item>",
      `<title>${xml(i.title)}</title>`,
      `<link>${xml(incidentLink(s, i))}</link>`,
      `<guid isPermaLink="false">${i.id}</guid>`,
      `<pubDate>${new Date(i.updatedAt).toUTCString()}</pubDate>`,
      `<description>${xml(summary(i))}</description>`,
      "</item>",
    ].join(""),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xml(s.page.name)} status</title>`,
    `<link>${xml(pageLink(s))}</link>`,
    `<atom:link href="${xml(pageLink(s, "feed.rss"))}" rel="self" type="application/rss+xml"/>`,
    `<description>Incidents on ${xml(s.page.name)}, newest first.</description>`,
    `<lastBuildDate>${new Date(s.publishedAt).toUTCString()}</lastBuildDate>`,
    ...items,
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}

export function atomFeed(s: Snapshot): string {
  const entries = incidents(s).map((i) =>
    [
      "<entry>",
      `<id>urn:uuid:${i.id}</id>`,
      `<title>${xml(i.title)}</title>`,
      `<link href="${xml(incidentLink(s, i))}"/>`,
      `<published>${i.startedAt}</published>`,
      `<updated>${i.updatedAt}</updated>`,
      `<content type="text">${xml(summary(i))}</content>`,
      "</entry>",
    ].join(""),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>${xml(pageLink(s))}</id>`,
    `<title>${xml(s.page.name)} status</title>`,
    `<link href="${xml(pageLink(s))}"/>`,
    `<link href="${xml(pageLink(s, "feed.atom"))}" rel="self"/>`,
    `<updated>${s.publishedAt}</updated>`,
    `<author><name>${xml(s.page.name)}</name></author>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
}
