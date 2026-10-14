import type { JobEngine } from "@galena/core";
import type { DraftDeadline } from "./autopilot.ts";

let current: JobEngine | undefined;

/** Set once by the host that runs the jobs: trigger.dev, the local dev process, a Lambda. */
export function setEngine(engine: JobEngine) {
  current = engine;
}

/** The engine that starts the jobs a job hands work to. */
export function engine(): JobEngine {
  if (!current) throw new Error("No job engine is set: the host calls setEngine before any job.");
  return current;
}

/** Hands a committed outbox row to `outbox.dispatch`, keyed `outbox:{outboxId}`. */
export const triggerDispatch = (outboxId: string) =>
  engine().trigger("outbox.dispatch", { outboxId }, { idempotencyKey: `outbox:${outboxId}` });

/** Starts a publish for `version`, keyed `pub:{version}`. */
export const triggerPublish = (version: number) =>
  engine().trigger("page.publish", { version }, { idempotencyKey: `pub:${version}` });

/**
 * Posts the draft's approval card and arms its deadline once, however often the transition is
 * retried: `card:{incidentId}` now, `auto:{incidentId}` at the deadline.
 */
export async function armDraft({ deadline, ...draft }: DraftDeadline) {
  const { workspaceId, incidentId } = draft;
  await engine().trigger(
    "slack.approval-card",
    { workspaceId, incidentId },
    { idempotencyKey: `card:${incidentId}` },
  );
  await engine().trigger("incident.autopilot", draft, {
    idempotencyKey: `auto:${incidentId}`,
    at: deadline,
  });
}
