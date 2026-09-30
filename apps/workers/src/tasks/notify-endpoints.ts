import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { AbortTaskRunError, logger, queue, task } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { deliver, endpointPayload, failDelivery, RetryableSendError } from "../endpoints.ts";
import { env } from "../env.ts";

const keys = appKeys(env.GLN_APP_KEY ?? LOCAL_APP_KEY);
const now = () => new Date();

/** Slack incoming webhooks and signed outgoing webhooks share everything but the body. */
function endpointTask(kind: "slack" | "webhook") {
  return task({
    id: `notify.${kind}`,
    queue: queue({ name: kind, concurrencyLimit: 10 }),
    // Basic retries: 5 attempts with backoff, then the endpoint is marked failing.
    retry: { maxAttempts: 5, factor: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 600_000 },
    run: async (payload: unknown) => {
      const request = endpointPayload.parse(payload);
      try {
        const outcome = await deliver(kind, request, { db, keys, guard, now });
        logger.info(`notify.${kind}`, { endpointId: request.endpointId, outcome });
        return { outcome };
      } catch (error) {
        // Timeouts, resets and 429/5xx can pass; anything else (a blocked address) won't.
        const transient =
          error instanceof RetryableSendError ||
          (error instanceof Error &&
            /timeout|ECONN|EAI_AGAIN|socket/i.test(`${error.name} ${error.message}`));
        if (!transient)
          throw new AbortTaskRunError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    onFailure: async ({ payload, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      await failDelivery(endpointPayload.parse(payload), reason, { db, now });
    },
  });
}

export const notifySlack = endpointTask("slack");
export const notifyWebhook = endpointTask("webhook");
