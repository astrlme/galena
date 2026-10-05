import { type EndpointKind, notice, webhookEndpointId } from "@galena/contracts";
import {
  claimDelivery,
  type Db,
  findDelivery,
  findEndpointForSend,
  markEndpointActive,
  markEndpointFailing,
  settleDelivery,
} from "@galena/db";
import {
  isRetryable,
  postJson,
  signWebhook,
  slackMessage,
  webhookBody,
} from "@galena/integrations/channels";
import type { Guard } from "@galena/integrations/net";
import { type AppKeys, open } from "@galena/integrations/secrets";
import { z } from "zod";

export const endpointPayload = z.object({ endpointId: webhookEndpointId, notice });
export type EndpointPayload = z.infer<typeof endpointPayload>;

export type EndpointDeps = {
  db: Db;
  keys: AppKeys;
  guard: Guard;
  now: () => Date;
  /** The task's attempt number, from 1: what the delivery is claimed for. */
  attempt: number;
  post?: typeof postJson;
};
export type EndpointOutcome = "sent" | "skipped" | "already_settled" | "refused";

/** Rate limited or the receiver failing: the task tries again with backoff. */
export class RetryableSendError extends Error {
  override name = "RetryableSendError";
}

/**
 * Only the guard refusing the address can't change on a retry. Timeouts, resets, 429/5xx and
 * the database resuming may all pass, so they get the task's retries before the endpoint is
 * marked failing.
 */
export const isFinalSendError = (error: unknown) =>
  error instanceof Error && error.name === "BlockedByGuardError";

/**
 * One notice to one Slack or webhook endpoint, recorded on its delivery row. The webhook id is
 * the delivery's, so it stays the same across retries and receivers can drop duplicates.
 */
export async function deliver(
  kind: EndpointKind,
  { endpointId, notice }: EndpointPayload,
  deps: EndpointDeps,
): Promise<EndpointOutcome> {
  const delivery = await findDelivery(deps.db, notice.eventId, { endpointId });
  if (delivery?.status !== "pending") return "already_settled";
  if (!(await claimDelivery(deps.db, delivery.id, deps.attempt))) return "already_settled";
  const attempts = deps.attempt;
  const endpoint = await findEndpointForSend(deps.db, endpointId);
  if (!endpoint || endpoint.kind !== kind || endpoint.state === "disabled") {
    await settleDelivery(deps.db, delivery.id, { status: "skipped", attempts });
    return "skipped";
  }
  const url = open(deps.keys, endpoint.urlSealed);
  const body = kind === "slack" ? JSON.stringify(slackMessage(notice)) : webhookBody(notice);
  const headers =
    kind === "webhook" && endpoint.secretSealed
      ? signWebhook({
          id: delivery.id,
          body,
          secret: open(deps.keys, endpoint.secretSealed),
          at: deps.now(),
        })
      : {};
  const { status } = await (deps.post ?? postJson)({ url, body, headers, guard: deps.guard });
  if (status >= 200 && status < 300) {
    await settleDelivery(deps.db, delivery.id, { status: "sent", attempts, sentAt: deps.now() });
    await markEndpointActive(deps.db, endpointId);
    return "sent";
  }
  if (isRetryable(status)) throw new RetryableSendError(`The endpoint answered HTTP ${status}.`);
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts,
    lastError: `The endpoint answered HTTP ${status}.`,
  });
  await markEndpointFailing(deps.db, endpointId, deps.now());
  return "refused";
}

/** After the last retry: the delivery failed and the endpoint is failing. */
export async function failDelivery(
  { endpointId, notice }: EndpointPayload,
  error: string,
  deps: { db: Db; now: () => Date },
) {
  const delivery = await findDelivery(deps.db, notice.eventId, { endpointId });
  if (delivery?.status !== "pending") return;
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts: delivery.attempts,
    lastError: error.slice(0, 500),
  });
  await markEndpointFailing(deps.db, endpointId, deps.now());
}
