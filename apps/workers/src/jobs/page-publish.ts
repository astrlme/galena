import { db } from "../db.ts";
import { engine } from "../engine.ts";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { noteFile, pageStore } from "../page-store.ts";
import { publishPage, publishPayload } from "../publishing.ts";
import { defineJob } from "../runner.ts";

/** Writes `snapshot.json`, the feeds, the badge and the favicons for the page, `pub:{version}`. */
export const pagePublishJob = defineJob({
  name: "page.publish",
  payload: publishPayload,
  run: async (request) => {
    const result = await publishPage(request, {
      db,
      clock: { now: () => new Date() },
      store: pageStore,
      note: noteFile,
      url: env.GLN_PAGE_URL,
      // Locally mail lands in GLN_MAIL_DIR; a deployment without an address has none to send.
      subscribe: Boolean(env.GLN_EMAIL_FROM) || !env.GLN_DB_CLUSTER_ARN,
      rebuildHtml: (version) =>
        engine().trigger("page.rebuild-html", { version }, { idempotencyKey: `html:${version}` }),
    });
    log.info("page.publish", { ...request, ...result });
    return result;
  },
});
