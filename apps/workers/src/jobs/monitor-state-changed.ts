import { monitorTransitioned } from "@galena/contracts";
import { nextSnapshotVersion, recordMonitorTransition } from "@galena/db";
import { actOnTransition } from "../autopilot.ts";
import { db } from "../db.ts";
import { armDraft, triggerDispatch, triggerPublish } from "../engine.ts";
import { log } from "../log.ts";
import { defineJob } from "../runner.ts";

/**
 * Started by the evaluator on every transition, keyed `mon:{monitorId}:{transitionSeq}`. Records
 * it as the monitor's state and in its history, lets autopilot open, move or attach an incident,
 * then republishes the page unless the transition happened inside a maintenance window.
 */
export const monitorStateChangedJob = defineJob({
  name: "monitor.state-changed",
  payload: monitorTransitioned,
  run: async (transition) => {
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
      dispatch: triggerDispatch,
      armDraft,
    });
    if (!data.suppressed) await triggerPublish(await nextSnapshotVersion(db));
    log.info("monitor.state-changed", { eventId: id, ...data, recorded, autopilot });
    return { recorded, autopilot };
  },
});
