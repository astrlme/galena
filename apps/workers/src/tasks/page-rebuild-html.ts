import { logger, queue, task } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { astroBuild, rebuildHtml, rebuildPayload } from "../html.ts";
import { pageStore } from "./page-store.ts";

// One build at a time; a queued run for an older version stops once newer HTML is out.
const builder = queue({ name: "builder", concurrencyLimit: 1 });

/**
 * Builds the status page's HTML with Astro and uploads it, after each publish (keyed
 * `html:{snapshotVersion}`). Known limit: Astro's incremental-build cache starts empty in each
 * container, so every build renders every page; the snapshot holds 14 days of incidents, so
 * that is a handful of pages.
 */
export const pageRebuildHtml = task({
  id: "page.rebuild-html",
  queue: builder,
  // Vite and Astro need more memory than the smallest machine has.
  machine: "small-2x",
  run: async (payload: unknown) => {
    const request = rebuildPayload.parse(payload);
    const result = await rebuildHtml(request, { db, store: pageStore, build: astroBuild });
    logger.info("page.rebuild-html", { ...request, ...result });
    return result;
  },
});
