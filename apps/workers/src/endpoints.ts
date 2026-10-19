import { type EndpointKind, notice, webhookEndpointId } from "@galena/contracts";
import { afterDelivery, type EndpointHealth, nextAttemptAt } from "@galena/core";
import {
  claimDelivery,
  type Db,
  findDelivery,
  findEndpointForSend,
  noteDeliveryError,
  setEndpointHealth,
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

export const endpointPayload = z.object({
  endpointId: webhookEndpointId,
  notice,
  /** Which try this is, from 1. Each retry is a job of its own, started at its time. */
  attempt: z.number().int().min(1).default(1),
});
export type EndpointPayload = z.infer<typeof endpointPayload>;

export type EndpointDeps = {
  db: Db;
  keys: AppKeys;
  guard: Guard;
  now: () => Date;
  /** The queue handed this attempt over before: the run that claimed it died. */
  redelivered: boolean;
  /** Starts the next attempt at its time, keyed `send:{eventId}:{endpointId}:{attempt}`. */
  retry: (next: EndpointPayload, at: Date) => Promise<void>;
  post?: typeof postJson;
};
export type EndpointOutcome =
  | "sent"
  | "skipped"
  | "already_settled"
  | "retrying"
  | "refused"
  | "failed";

/**
 * Only the guard refusing the address can't change on a retry. Timeouts, resets and the
 * receiver failing may all pass.
 */
export const isFinalSendError = (error: unknown) =>
  error instanceof Error && error.name === "BlockedByGuardError";

/**
 * One attempt to send one notice to one Slack or webhook endpoint, recorded on its delivery row.
 * A busy or unreachable receiver gets the next attempt at its time, until the schedule runs
 * out; the webhook id is the delivery's, so receivers can drop the duplicates.
 */
export async function deliver(
  kind: EndpointKind,
  payload: EndpointPayload,
  deps: EndpointDeps,
): Promise<EndpointOutcome> {
  const { endpointId, notice, attempt } = payload;
  const delivery = await findDelivery(deps.db, notice.eventId, { endpointId });
  if (delivery?.status !== "pending") return "already_settled";
  if (!(await claimDelivery(deps.db, delivery.id, attempt, deps.redelivered))) {
    return "already_settled";
  }
  const endpoint = await findEndpointForSend(deps.db, endpointId);
  if (!endpoint || endpoint.kind !== kind || endpoint.state === "disabled") {
    await settleDelivery(deps.db, delivery.id, { status: "skipped", attempts: attempt });
    return "skipped";
  }
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
  const failure = await send(deps, { url: open(deps.keys, endpoint.urlSealed), body, headers });
  if (!failure) {
    await settleDelivery(deps.db, delivery.id, {
      status: "sent",
      attempts: attempt,
      sentAt: deps.now(),
    });
    await moveEndpoint(deps, endpoint, "sent");
    return "sent";
  }
  const next = failure.retryable ? nextAttemptAt(kind, attempt, deps.now()) : undefined;
  if (next) {
    await deps.retry({ ...payload, attempt: attempt + 1 }, next);
    await noteDeliveryError(deps.db, delivery.id, failure.error);
    return "retrying";
  }
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts: attempt,
    lastError: failure.error,
  });
  await moveEndpoint(deps, endpoint, "failed");
  return failure.retryable ? "failed" : "refused";
}

/** What went wrong, in words a member reads in the delivery log; nothing when it got through. */
async function send(
  deps: EndpointDeps,
  request: { url: string; body: string; headers: Record<string, string> },
): Promise<{ error: string; retryable: boolean } | undefined> {
  try {
    const { status } = await (deps.post ?? postJson)({ ...request, guard: deps.guard });
    if (status >= 200 && status < 300) return undefined;
    return { error: `The endpoint answered HTTP ${status}.`, retryable: isRetryable(status) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The request failed.";
    return { error: `Couldn't reach the endpoint: ${reason}`, retryable: !isFinalSendError(error) };
  }
}

async function moveEndpoint(
  deps: EndpointDeps,
  endpoint: EndpointHealth & { id: EndpointPayload["endpointId"] },
  outcome: "sent" | "failed",
) {
  const next = afterDelivery(endpoint, outcome, deps.now());
  // A member who turned it on meanwhile wins: the compare-and-set finds it moved.
  if (next.state !== endpoint.state) {
    await setEndpointHealth(deps.db, endpoint.id, endpoint.state, next);
  }
}

/**
 * Our own fault (the database, the queue) outlasted the job's retries: the delivery failed, but
 * the endpoint did nothing wrong, so its state stays.
 */
export async function failDelivery(
  { endpointId, notice }: EndpointPayload,
  error: unknown,
  deps: { db: Db },
) {
  const delivery = await findDelivery(deps.db, notice.eventId, { endpointId });
  if (delivery?.status !== "pending") return;
  const name = error instanceof Error ? error.name : "Error";
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts: delivery.attempts,
    lastError: `Galena couldn't send it (${name}).`,
  });
}
