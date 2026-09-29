import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { localPageStore, publishPage, publishPayload, s3PageStore } from "../publishing.ts";

// One run at a time, so each publish reads the database after the one before it wrote.
const publisher = queue({ name: "publisher", concurrencyLimit: 1 });

const store = env.GLN_PAGE_BUCKET
  ? s3PageStore({ region: env.GLN_PAGE_REGION, bucket: env.GLN_PAGE_BUCKET })
  : localPageStore(env.GLN_PAGE_DIR);

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
      store,
      url: env.GLN_PAGE_URL,
    });
    logger.info("page.publish", { ...request, ...result });
    return result;
  },
});
