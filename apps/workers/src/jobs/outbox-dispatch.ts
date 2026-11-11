import { db } from "../db.ts";
import { engine, triggerPublish } from "../engine.ts";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { dispatchOutbox, localMonitorsFile, s3MonitorsFile } from "../outbox.ts";
import { dispatchPayload, retryDispatch } from "../outbox-triggers.ts";
import { defineJob } from "../runner.ts";

const writeMonitorsFile = env.GLN_CONFIG_BUCKET
  ? s3MonitorsFile({
      region: env.GLN_HOME_REGION,
      bucket: env.GLN_CONFIG_BUCKET,
      key: env.GLN_CONFIG_KEY,
    })
  : localMonitorsFile(env.GLN_CONFIG_DIR);

/**
 * After each committed change, keyed `outbox:{outboxId}`: hands its event to its consumers. One
 * that fails every attempt tries again later, keyed `outbox:{outboxId}:retry:{n}`.
 */
export const outboxDispatchJob = defineJob({
  name: "outbox.dispatch",
  payload: dispatchPayload,
  run: async ({ outboxId: id }) => {
    const outcome = await dispatchOutbox(id, {
      db,
      clock: { now: () => new Date() },
      writeMonitorsFile,
      runs: {
        start: (window, idempotencyKey) =>
          engine().trigger("maintenance.lifecycle", window, { idempotencyKey }),
      },
      publish: triggerPublish,
      confirm: ({ eventId, subscriberId }) =>
        engine().trigger(
          "notify.email",
          { kind: "confirmation", subscriberId, eventId },
          { idempotencyKey: `send:${eventId}:${subscriberId}` },
        ),
      fanOut: (event) =>
        engine().trigger("notify.fanout", event, { idempotencyKey: `fan:${event.id}` }),
    });
    log.info("outbox.dispatch", { outboxId: id, outcome });
    return { outcome };
  },
  onFailure: (payload, error) =>
    retryDispatch(payload, error, {
      clock: { now: () => new Date() },
      schedule: (next, options) => engine().trigger("outbox.dispatch", next, options),
    }),
});
