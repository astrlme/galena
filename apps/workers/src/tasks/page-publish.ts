import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { publishPage, publishPayload } from "../publishing.ts";
import { globalKey } from "./keys.ts";
import { noteFile, pageStore } from "./page-store.ts";

// One run at a time, so each publish reads the database after the one before it wrote.
const publisher = queue({ name: "publisher", concurrencyLimit: 1 });

/** Starts a publish for `version`, keyed `pub:{version}`. */
export async function triggerPublish(version: number): Promise<void> {
  await tasks.trigger(
    "page.publish",
    { version },
    { idempotencyKey: await globalKey(`pub:${version}`) },
  );
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
      note: noteFile,
      url: env.GLN_PAGE_URL,
      // Locally mail lands in GLN_MAIL_DIR; a deployment without an address has none to send.
      subscribe: Boolean(env.GLN_EMAIL_FROM) || !env.GLN_DB_CLUSTER_ARN,
      rebuildHtml: async (version) => {
        await tasks.trigger(
          "page.rebuild-html",
          { version },
          { idempotencyKey: await globalKey(`html:${version}`) },
        );
      },
    });
    logger.info("page.publish", { ...request, ...result });
    return result;
  },
});
