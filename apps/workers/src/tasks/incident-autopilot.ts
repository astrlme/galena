import { incidentRepository } from "@galena/db";
import { idempotencyKeys, logger, queue, task, tasks, wait } from "@trigger.dev/sdk";
import { type DraftPayload, draftPayload, settleDraft } from "../autopilot.ts";
import { db } from "../db.ts";

export const incidents = queue({ name: "incidents", concurrencyLimit: 5 });

/** What a person sends when they answer a draft (from Slack or the dashboard). */
export type DraftAnswer = { decision: "approve" | "dismiss" };

/**
 * Hands a committed outbox row to `outbox.dispatch`. The key is global: a plain string key
 * triggered inside a task only dedupes within that run.
 */
export async function dispatchOutbox(outboxId: string) {
  await tasks.trigger(
    "outbox.dispatch",
    { outboxId },
    { idempotencyKey: await idempotencyKeys.create(`outbox:${outboxId}`, { scope: "global" }) },
  );
}

/** Starts the approval wait for a draft once, however often the transition is retried. */
export async function awaitApproval(draft: DraftPayload) {
  await tasks.trigger("incident.autopilot", draft, {
    idempotencyKey: await idempotencyKeys.create(`auto:${draft.incidentId}`, { scope: "global" }),
  });
}

/**
 * One draft a monitor opened: waits for a person until its deadline, then publishes or
 * dismisses it. The token's id is stored on the incident, so an answer can complete it.
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
      waitForAnswer: async ({ workspaceId, incidentId, deadline }) => {
        const token = await wait.createToken({
          idempotencyKey: `approve:${incidentId}`,
          timeout: deadline,
        });
        await incidentRepository(db).setApprovalToken(workspaceId, incidentId, token.id);
        const answer = await wait.forToken<DraftAnswer>(token);
        if (!answer.ok) return "timed_out";
        return answer.output.decision === "approve" ? "approved" : "dismissed";
      },
    });
    logger.info("incident.autopilot", { ...draft, outcome });
    return { outcome };
  },
});
