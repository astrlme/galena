import { guard } from "@galena/integrations/net";
import { appKeys } from "@galena/integrations/secrets";
import { db } from "../db.ts";
import { deliver, endpointPayload, failDelivery } from "../endpoints.ts";
import { engine } from "../engine.ts";
import { appKey } from "../env.ts";
import { log } from "../log.ts";
import { defineJob } from "../runner.ts";

const keys = appKeys(appKey());
const now = () => new Date();

/** Slack incoming webhooks and signed outgoing webhooks share everything but the body. */
function endpointJob(kind: "slack" | "webhook") {
  const name = `notify.${kind}`;
  return defineJob({
    name,
    payload: endpointPayload,
    // For our own faults: a receiver that fails gets its next attempt as a job of its own.
    retry: { attempts: 5, factor: 3, minMs: 5_000, maxMs: 600_000 },
    run: async (request, { attempt }) => {
      const outcome = await deliver(kind, request, {
        db,
        keys,
        guard,
        now,
        redelivered: attempt > 1,
        retry: (next, at) =>
          engine().trigger(name, next, {
            idempotencyKey: `send:${next.notice.eventId}:${next.endpointId}:${next.attempt}`,
            at,
          }),
      });
      log.info(name, { endpointId: request.endpointId, attempt: request.attempt, outcome });
      return { outcome };
    },
    onFailure: (request, error) => failDelivery(request, error, { db }),
  });
}

export const notifySlackJob = endpointJob("slack");
export const notifyWebhookJob = endpointJob("webhook");
