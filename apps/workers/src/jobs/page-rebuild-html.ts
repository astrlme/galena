import { db } from "../db.ts";
import { astroBuild, rebuildHtml, rebuildPayload } from "../html.ts";
import { log } from "../log.ts";
import { pageStore } from "../page-store.ts";
import { defineJob } from "../runner.ts";

/**
 * Builds the status page's HTML with Astro and uploads it, after each publish (keyed
 * `html:{snapshotVersion}`); an older version stops once newer HTML is out. Known limit:
 * Astro's incremental-build cache starts empty in each container, so every build renders every
 * page; the snapshot holds 14 days of incidents, so that is a handful of pages.
 */
export const pageRebuildHtmlJob = defineJob({
  name: "page.rebuild-html",
  payload: rebuildPayload,
  run: async (request) => {
    const result = await rebuildHtml(request, { db, store: pageStore, build: astroBuild });
    log.info("page.rebuild-html", { ...request, ...result });
    return result;
  },
});
