import { outboxId } from "@galena/contracts";
import { createDb } from "@galena/db";
import { logger, queue, task } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "../env.ts";
import { dispatchOutbox, localMonitorsFile, s3MonitorsFile } from "../outbox.ts";

// Known limit: one run at a time for the whole outbox. Each run rebuilds monitors.json from the
// database, so running them in order means the newest committed state is always written last.
// Split per event type once other consumers make the queue busy.
const outbox = queue({ name: "outbox", concurrencyLimit: 1 });

const { db } = createDb({ kind: "postgres", url: env.GLN_DATABASE_URL });
const writeMonitorsFile = env.GLN_CONFIG_BUCKET
  ? s3MonitorsFile({
      region: env.GLN_HOME_REGION,
      bucket: env.GLN_CONFIG_BUCKET,
      key: env.GLN_CONFIG_KEY,
    })
  : localMonitorsFile(env.GLN_CONFIG_DIR);

/** Triggered by the API after each committed change, keyed `outbox:{outboxId}`. */
export const outboxDispatch = task({
  id: "outbox.dispatch",
  queue: outbox,
  run: async (payload: unknown) => {
    const { outboxId: id } = z.object({ outboxId }).parse(payload);
    const outcome = await dispatchOutbox(id, {
      db,
      clock: { now: () => new Date() },
      writeMonitorsFile,
    });
    logger.info("outbox.dispatch", { outboxId: id, outcome });
    return { outcome };
  },
});
