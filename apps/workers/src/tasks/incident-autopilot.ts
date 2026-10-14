import { logger, queue, task, tasks } from "@trigger.dev/sdk";
import { type DraftPayload, draftPayload, settleDraft } from "../autopilot.ts";
import { db } from "../db.ts";
import { globalKey } from "./keys.ts";

export const incidents = queue({ name: "incidents", concurrencyLimit: 5 });

/** Hands a committed outbox row to `outbox.dispatch`. */
export async function dispatchOutbox(outboxId: string) {
  await tasks.trigger(
    "outbox.dispatch",
    { outboxId },
    { idempotencyKey: await globalKey(`outbox:${outboxId}`) },
  );
}

/** Posts a draft's Slack approval card once, keyed `card:{incidentId}`. */
async function triggerApprovalCard({ workspaceId, incidentId }: DraftPayload) {
  await tasks.trigger(
    "slack.approval-card",
    { workspaceId, incidentId },
    { idempotencyKey: await globalKey(`card:${incidentId}`) },
  );
}

/**
 * Posts the draft's approval card and arms its deadline once, however often the transition is
 * retried.
 */
export async function awaitApproval({ deadline, ...draft }: DraftPayload & { deadline: Date }) {
  await triggerApprovalCard(draft);
  await tasks.trigger("incident.autopilot", draft, {
    idempotencyKey: await globalKey(`auto:${draft.incidentId}`),
    delay: deadline,
  });
}

/**
 * One draft a monitor or an alert group opened, at its deadline: publishes or dismisses it,
 * unless a person decided it first.
 */
export const incidentAutopilot = task({
  id: "incident.autopilot",
  queue: incidents,
  run: async (payload: unknown) => {
    const draft = draftPayload.parse(payload);
    const outcome = await settleDraft(draft, {
      db,
      clock: { now: () => new Date() },
      dispatch: dispatchOutbox,
    });
    logger.info("incident.autopilot", { ...draft, outcome });
    return { outcome };
  },
});
