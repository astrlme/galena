import { signalIdempotencyKey, signalIngest } from "@galena/contracts";
import { db } from "../db.ts";
import { armDraft, triggerDispatch } from "../engine.ts";
import { log } from "../log.ts";
import { defineJob } from "../runner.ts";
import { actOnSignal } from "../signals.ts";

/**
 * Started by the API's `/hooks/<source>/<token>`, keyed
 * `sig:{integrationId}:{fingerprint}:{status}:{startsAt}`. Opens, attaches or resolves the alert
 * group's incident; a notification already acted on changes nothing.
 */
export const signalIngestJob = defineJob({
  name: "signal.ingest",
  payload: signalIngest,
  run: async (ingest) => {
    const result = await actOnSignal(ingest, {
      db,
      clock: { now: () => new Date() },
      dispatch: triggerDispatch,
      armDraft,
    });
    log.info("signal.ingest", {
      key: signalIdempotencyKey(ingest),
      integrationId: ingest.integrationId,
      fingerprint: ingest.signal.fingerprint,
      status: ingest.signal.status,
      ...result,
    });
    return result;
  },
});
