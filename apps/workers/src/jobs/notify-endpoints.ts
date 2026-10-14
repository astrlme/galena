import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { db } from "../db.ts";
import { deliver, endpointPayload, failDelivery, isFinalSendError } from "../endpoints.ts";
import { env } from "../env.ts";
import { log } from "../log.ts";
import { defineJob, FinalError } from "../runner.ts";

const keys = appKeys(env.GLN_APP_KEY ?? LOCAL_APP_KEY);
const now = () => new Date();

/** Slack incoming webhooks and signed outgoing webhooks share everything but the body. */
function endpointJob(kind: "slack" | "webhook") {
  return defineJob({
    name: `notify.${kind}`,
    payload: endpointPayload,
    // Basic retries: 5 attempts with backoff, then the endpoint is marked failing.
    retry: { attempts: 5, factor: 3, minMs: 5_000, maxMs: 600_000 },
    run: async (request, { attempt }) => {
      try {
        const outcome = await deliver(kind, request, { db, keys, guard, now, attempt });
        log.info(`notify.${kind}`, { endpointId: request.endpointId, outcome });
        return { outcome };
      } catch (error) {
        if (isFinalSendError(error)) throw new FinalError((error as Error).message);
        throw error;
      }
    },
    onFailure: async (request, error) => {
      const reason = error instanceof Error ? error.message : String(error);
      await failDelivery(request, reason, { db, now });
    },
  });
}

export const notifySlackJob = endpointJob("slack");
export const notifyWebhookJob = endpointJob("webhook");
