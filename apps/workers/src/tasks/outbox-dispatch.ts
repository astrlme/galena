import { outboxId } from "@galena/contracts";
import { logger, queue, runs, task, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { dispatchOutbox, localMonitorsFile, s3MonitorsFile } from "../outbox.ts";
import { triggerPublish } from "./page-publish.ts";

// Known limit: one run at a time for the whole outbox. Each run rebuilds monitors.json from the
// database, so running them in order means the newest committed state is always written last.
// Split per event type once other consumers make the queue busy.
const outbox = queue({ name: "outbox", concurrencyLimit: 1 });

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
      runs: {
        start: async (window, idempotencyKey) =>
          (await tasks.trigger("maintenance.lifecycle", window, { idempotencyKey })).id,
        cancel: async (runId) => {
          await runs.cancel(runId);
        },
      },
      publish: triggerPublish,
    });
    logger.info("outbox.dispatch", { outboxId: id, outcome });
    return { outcome };
  },
});
