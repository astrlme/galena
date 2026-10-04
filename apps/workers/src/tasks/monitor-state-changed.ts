import { monitorTransitioned } from "@galena/contracts";
import { nextSnapshotVersion, recordMonitorTransition } from "@galena/db";
import { logger, task } from "@trigger.dev/sdk";
import { actOnTransition } from "../autopilot.ts";
import { db } from "../db.ts";
import { awaitApproval, dispatchOutbox, incidents } from "./incident-autopilot.ts";
import { triggerPublish } from "./page-publish.ts";

// Triggered by the evaluator on every transition, keyed `mon:{monitorId}:{transitionSeq}`.
// Records it as the monitor's state and in its history, lets autopilot open, move or attach an
// incident, then republishes the page unless the transition happened inside a maintenance window.
export const monitorStateChanged = task({
  id: "monitor.state-changed",
  queue: incidents,
  run: async (payload: unknown) => {
    const transition = monitorTransitioned.parse(payload);
    const { id, workspaceId, occurredAt, data } = transition;
    const recorded = await recordMonitorTransition(db, {
      workspaceId,
      monitorId: data.monitorId,
      from: data.from,
      to: data.to,
      seq: data.transitionSeq,
      at: new Date(occurredAt),
    });
    const autopilot = await actOnTransition(transition, {
      db,
      clock: { now: () => new Date() },
      dispatch: dispatchOutbox,
      awaitApproval,
    });
    if (!data.suppressed) await triggerPublish(await nextSnapshotVersion(db));
    logger.info("monitor.state-changed", { eventId: id, ...data, recorded, autopilot });
    return { recorded, autopilot };
  },
});
