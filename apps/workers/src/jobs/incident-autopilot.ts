import { draftPayload, settleDraft } from "../autopilot.ts";
import { db } from "../db.ts";
import { triggerDispatch } from "../engine.ts";
import { log } from "../log.ts";
import { defineJob } from "../runner.ts";

/**
 * One draft a monitor or an alert group opened, at its deadline: publishes or dismisses it,
 * unless a person decided it first.
 */
export const incidentAutopilotJob = defineJob({
  name: "incident.autopilot",
  payload: draftPayload,
  run: async (draft) => {
    const outcome = await settleDraft(draft, {
      db,
      clock: { now: () => new Date() },
      dispatch: triggerDispatch,
    });
    log.info("incident.autopilot", { ...draft, outcome });
    return { outcome };
  },
});
