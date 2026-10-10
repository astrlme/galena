import { BatchGetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type MonitorId, type MonitorState, monitorId } from "@galena/contracts";
import { type Clock, TRANSITION_SETTLE_MS } from "@galena/core";
import { type Db, listMonitorStates, recordMonitorTransition } from "@galena/db";

/** The state detection holds for a monitor: `MON#<id>` / `STATE` in the telemetry table. */
export type DetectedState = { state: MonitorState; transitionSeq: number; enteredAt: number };
export type ReadStates = (ids: readonly MonitorId[]) => Promise<Map<MonitorId, DetectedState>>;

/**
 * Records the state detection holds for each monitor whose recorded state fell behind it. A
 * `monitor.state-changed` run that failed for good leaves Postgres on the old state until the
 * next transition; recording is keyed by (monitor, seq), so a run that arrives later is a no-op.
 */
export async function catchUpStates(deps: {
  db: Db;
  clock: Clock;
  readStates: ReadStates;
}): Promise<{ caughtUp: number }> {
  const monitors = await listMonitorStates(deps.db);
  const detected = await deps.readStates(monitors.map((m) => m.id));
  const settled = deps.clock.now().getTime() - TRANSITION_SETTLE_MS;
  let caughtUp = 0;
  for (const m of monitors) {
    const d = detected.get(m.id);
    if (!d || d.transitionSeq <= m.stateSeq || d.enteredAt > settled) continue;
    const recorded = await recordMonitorTransition(deps.db, {
      workspaceId: m.workspaceId,
      monitorId: m.id,
      from: m.state,
      to: d.state,
      seq: d.transitionSeq,
      at: new Date(d.enteredAt),
    });
    if (recorded) caughtUp++;
  }
  return { caughtUp };
}

/** Reads the states the evaluator writes; the workers never write telemetry. */
export function dynamoStates(doc: DynamoDBDocumentClient, table: string): ReadStates {
  return async (ids) => {
    const found = new Map<MonitorId, DetectedState>();
    for (let i = 0; i < ids.length; i += 100) {
      const keys = ids.slice(i, i + 100).map((id) => ({ pk: `MON#${id}`, sk: "STATE" }));
      const { Responses, UnprocessedKeys } = await doc.send(
        new BatchGetCommand({
          RequestItems: { [table]: { Keys: keys, ProjectionExpression: "pk, detection" } },
        }),
      );
      if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
        throw new Error("DynamoDB left monitor states unread; the next run reads them again.");
      }
      for (const item of Responses?.[table] ?? []) {
        // Our own item, written by the evaluator.
        found.set(monitorId.parse(String(item.pk).slice("MON#".length)), item.detection);
      }
    }
    return found;
  };
}
