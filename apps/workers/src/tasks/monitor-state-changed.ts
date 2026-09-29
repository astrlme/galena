import { monitorTransitioned } from "@galena/contracts";
import { recordMonitorTransition } from "@galena/db";
import { logger, task } from "@trigger.dev/sdk";
import { db } from "../db.ts";

// Triggered by the evaluator on every transition, keyed `mon:{monitorId}:{transitionSeq}`.
// Records it as the monitor's state and in its history; drafting incidents comes with the
// incident workflow.
export const monitorStateChanged = task({
  id: "monitor.state-changed",
  run: async (payload: unknown) => {
    const { id, workspaceId, occurredAt, data } = monitorTransitioned.parse(payload);
    const recorded = await recordMonitorTransition(db, {
      workspaceId,
      monitorId: data.monitorId,
      from: data.from,
      to: data.to,
      seq: data.transitionSeq,
      at: new Date(occurredAt),
    });
    logger.info("monitor.state-changed", { eventId: id, ...data, recorded });
    return { recorded };
  },
});
