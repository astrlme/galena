import { type OutboxId, outboxId } from "@galena/contracts";
import type { Clock } from "@galena/core";
import { v7 } from "uuid";
import { z } from "zod";

/** How a run hands the outbox rows it commits to `outbox.dispatch`. */
export type OutboxTriggers = {
  /**
   * Before the transaction: a dispatch a minute out. If the run dies or the trigger fails after
   * the commit, its retry finds the change already made and dispatches nothing, so this one sends
   * the row; if nothing commits, it finds no row and stops.
   */
  backstop: (outboxId: OutboxId) => Promise<void>;
  /** After the commit. */
  dispatch: (outboxId: OutboxId) => Promise<void>;
};

/** A new outbox row's id, with its backstop armed: call it before the transaction. */
export async function armedOutboxId(triggers: Pick<OutboxTriggers, "backstop">) {
  const id: OutboxId = outboxId.parse(v7());
  await triggers.backstop(id);
  return id;
}

// After a dispatch has failed every attempt, it runs again after each of these waits; past the
// last one the outbox sweep and the dead-letter alarm take over.
const RETRY_WAITS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export const dispatchPayload = z.object({
  outboxId,
  retry: z.number().int().min(1).max(RETRY_WAITS_MS.length).optional(),
});
export type DispatchPayload = z.infer<typeof dispatchPayload>;

/**
 * `outbox.dispatch`'s failure hook: arms its next retry, keyed `outbox:{outboxId}:retry:{n}`, so
 * a row whose dispatch failed through a few minutes' outage goes out within the hour instead of
 * at the six-hourly sweep. Each retry wakes Aurora only for a row that is still pending. Past the
 * last retry it throws, which leaves the message to the dead-letter queue.
 */
export async function retryDispatch(
  { outboxId: id, retry = 0 }: DispatchPayload,
  error: unknown,
  deps: {
    clock: Clock;
    schedule: (
      payload: Required<DispatchPayload>,
      options: { idempotencyKey: string; at: Date },
    ) => Promise<void>;
  },
) {
  const wait = RETRY_WAITS_MS[retry];
  if (wait === undefined) throw error;
  const next = retry + 1;
  await deps.schedule(
    { outboxId: id, retry: next },
    {
      idempotencyKey: `outbox:${id}:retry:${next}`,
      at: new Date(deps.clock.now().getTime() + wait),
    },
  );
}
