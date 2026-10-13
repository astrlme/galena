import { signalIdempotencyKey, signalIngest } from "@galena/contracts";
import { logger, queue, task } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { actOnSignal } from "../signals.ts";
import { awaitApproval, dispatchOutbox } from "./incident-autopilot.ts";

// Known limit: one alert group at a time across every integration, so a group's firing and
// resolve messages never race; a burst waits its turn. Key the queue by fingerprint if bursts grow.
export const signals = queue({ name: "signals", concurrencyLimit: 1 });

// Triggered by the API's `/hooks/<source>/<token>`, keyed
// `sig:{integrationId}:{fingerprint}:{status}:{startsAt}`, so a source repeating a notification
// starts no run. Opens, attaches or resolves the alert group's incident.
export const signalIngestTask = task({
  id: "signal.ingest",
  queue: signals,
  run: async (payload: unknown) => {
    const ingest = signalIngest.parse(payload);
    const result = await actOnSignal(ingest, {
      db,
      clock: { now: () => new Date() },
      dispatch: dispatchOutbox,
      awaitApproval,
    });
    logger.info("signal.ingest", {
      key: signalIdempotencyKey(ingest),
      integrationId: ingest.integrationId,
      fingerprint: ingest.signal.fingerprint,
      status: ingest.signal.status,
      ...result,
    });
    return result;
  },
});
