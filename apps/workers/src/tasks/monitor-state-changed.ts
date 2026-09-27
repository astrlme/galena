import { monitorTransitioned } from "@galena/contracts";
import { logger, task } from "@trigger.dev/sdk";

// Triggered by the evaluator on every transition, keyed `mon:{monitorId}:{transitionSeq}`.
// For now it only records the transition; drafting incidents comes with the incident workflow.
export const monitorStateChanged = task({
  id: "monitor.state-changed",
  run: async (payload: unknown) => {
    const { id, data } = monitorTransitioned.parse(payload);
    logger.info("monitor.state-changed", { eventId: id, ...data });
  },
});
