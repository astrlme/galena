import {
  type EndpointKind,
  notice,
  type WebhookEndpointId,
  webhookEndpointId,
} from "@galena/contracts";
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
import { endpointRequest, type postJson, postToEndpoint } from "@galena/integrations/channels";
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
  /** Starts the next attempt at its time, keyed `attemptKey(next)`. */
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
 * A later attempt's key, `send:{eventId}:{endpointId}:{attempt}`: a job of its own, in the
 * first send's lane, so other deliveries to the endpoint don't wait out its wait.
 */
export const attemptKey = (next: EndpointPayload) =>
  `send:${next.notice.eventId}:${next.endpointId}:${next.attempt}`;

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
  const request = endpointRequest(kind, notice, {
    id: delivery.id,
    secret: endpoint.secretSealed && open(deps.keys, endpoint.secretSealed),
    at: deps.now(),
  });
  const answer = await postToEndpoint(
    { ...request, url: open(deps.keys, endpoint.urlSealed), guard: deps.guard },
    deps.post,
  );
  if (answer.ok) {
    await settleDelivery(deps.db, delivery.id, {
      status: "sent",
      attempts: attempt,
      sentAt: deps.now(),
    });
    await moveEndpoint(deps, endpoint, "sent");
    return "sent";
  }
  const next = answer.retryable ? nextAttemptAt(kind, attempt, deps.now()) : undefined;
  if (next) {
    await deps.retry({ ...payload, attempt: attempt + 1 }, next);
    await noteDeliveryError(deps.db, delivery.id, answer.error);
    return "retrying";
  }
  await settleDelivery(deps.db, delivery.id, {
    status: "failed",
    attempts: attempt,
    lastError: answer.error,
  });
  await moveEndpoint(deps, endpoint, "failed");
  return answer.retryable ? "failed" : "refused";
}

async function moveEndpoint(
  deps: EndpointDeps,
  endpoint: EndpointHealth & { id: WebhookEndpointId },
  outcome: "sent" | "failed",
) {
  const next = afterDelivery(endpoint, outcome, deps.now());
  // A member who turned it on meanwhile, or another delivery, wins: the compare-and-set misses.
  if (next.state !== endpoint.state) {
    await setEndpointHealth(deps.db, endpoint.id, endpoint, next);
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
