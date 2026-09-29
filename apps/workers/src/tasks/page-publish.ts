import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { publishPage, publishPayload } from "../publishing.ts";
import { pageStore } from "./page-store.ts";

// One run at a time, so each publish reads the database after the one before it wrote.
const publisher = queue({ name: "publisher", concurrencyLimit: 1 });

/** Starts a publish for `version`, keyed `pub:{version}`. */
export async function triggerPublish(version: number): Promise<void> {
  await tasks.trigger("page.publish", { version }, { idempotencyKey: `pub:${version}` });
}

/** Writes `snapshot.json`, the feeds, the badge and the favicons for the page. */
export const pagePublish = task({
  id: "page.publish",
  queue: publisher,
  run: async (payload: unknown) => {
    const request = publishPayload.parse(payload);
    const result = await publishPage(request, {
      db,
      clock: { now: () => new Date() },
      store: pageStore,
      url: env.GLN_PAGE_URL,
      rebuildHtml: async (version) => {
        await tasks.trigger(
          "page.rebuild-html",
          { version },
          { idempotencyKey: `html:${version}` },
        );
      },
    });
    logger.info("page.publish", { ...request, ...result });
    return result;
  },
});
