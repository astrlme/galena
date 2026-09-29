import type { Snapshot } from "@galena/contracts";
import { pageIndicatorStates } from "@galena/contracts";
import { atomFeed, rssFeed } from "./feeds.ts";
import type { GlyphState } from "./glyphs.ts";
import { badgeSvg, faviconSvg } from "./images.ts";

export { atomFeed, rssFeed } from "./feeds.ts";
export type { GlyphState } from "./glyphs.ts";
export { badgeSvg, faviconSvg } from "./images.ts";

export type PageFile = { path: string; body: string; contentType: string };

const FAVICON_STATES: GlyphState[] = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
  "no_data",
];

/**
 * Every data file `page.publish` writes for a snapshot, paths relative to the page's root. The
 * HTML comes from the status page's own build; `favicon.svg` is the current state's glyph.
 */
export function pageFiles(snapshot: Snapshot): PageFile[] {
  const svg = "image/svg+xml";
  return [
    {
      path: "snapshot.json",
      body: `${JSON.stringify(snapshot)}\n`,
      contentType: "application/json",
    },
    {
      path: "feed.rss",
      body: rssFeed(snapshot),
      contentType: "application/rss+xml; charset=utf-8",
    },
    {
      path: "feed.atom",
      body: atomFeed(snapshot),
      contentType: "application/atom+xml; charset=utf-8",
    },
    { path: "badge.svg", body: badgeSvg(snapshot.indicator), contentType: svg },
    {
      path: "favicon.svg",
      body: faviconSvg(pageIndicatorStates[snapshot.indicator]),
      contentType: svg,
    },
    ...FAVICON_STATES.map((state) => ({
      path: `favicons/${state}.svg`,
      body: faviconSvg(state),
      contentType: svg,
    })),
  ];
}
