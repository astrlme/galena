import { ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { MonitorId, MonitorState, RecentResult } from "@galena/contracts";

/** Scheduled minutes of results the dashboard shows per monitor. */
export const RECENT_MINUTES = 60;

export type MonitorReading = {
  state: MonitorState;
  /** Epoch ms; 0 before the first check. */
  enteredAt: number;
  /** Newest first. */
  results: RecentResult[];
};

/** Reads what the evaluator writes; the API never writes telemetry. */
export type Telemetry = {
  regions: readonly string[];
  read(ids: readonly MonitorId[]): Promise<Map<MonitorId, MonitorReading>>;
};

/**
 * `MON#<id>` / `STATE` for the detection state and `MON#<id>` / `R#<minute>#<region>` for
 * results. A missing table reads as no data: locally it appears when the hot path first runs.
 */
export function dynamoTelemetry(
  doc: DynamoDBDocumentClient,
  table: string,
  regions: readonly string[],
): Telemetry {
  async function states(ids: readonly MonitorId[]) {
    const found = new Map<string, { state: MonitorState; enteredAt: number }>();
    for (let i = 0; i < ids.length; i += 100) {
      const keys = ids.slice(i, i + 100).map((id) => ({ pk: `MON#${id}`, sk: "STATE" }));
      const { Responses, UnprocessedKeys } = await doc.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }),
      );
      if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
        throw new Error("DynamoDB left monitor states unread; reload to try again.");
      }
      for (const item of Responses?.[table] ?? []) {
        found.set(String(item.pk).slice("MON#".length), item.detection);
      }
    }
    return found;
  }

  async function results(id: MonitorId): Promise<RecentResult[]> {
    const { Items = [] } = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :results)",
        ExpressionAttributeValues: { ":pk": `MON#${id}`, ":results": "R#" },
        ScanIndexForward: false,
        Limit: RECENT_MINUTES * regions.length,
      }),
    );
    // A region that missed minutes leaves room for older ones; keep the newest minutes only.
    const minutes = new Set<string>();
    const recent: RecentResult[] = [];
    for (const item of Items) {
      const [, scheduledAt = "", region = ""] = String(item.sk).split("#");
      minutes.add(scheduledAt);
      if (minutes.size > RECENT_MINUTES) break;
      recent.push({ region, scheduledAt, status: item.status, latencyMs: item.latencyMs ?? null });
    }
    return recent;
  }

  return {
    regions,
    async read(ids) {
      const readings = new Map<MonitorId, MonitorReading>();
      try {
        const detection = await states(ids);
        // A few monitors at a time: each query reads up to an hour of results.
        for (let i = 0; i < ids.length; i += 10) {
          const batch = ids.slice(i, i + 10);
          const recent = await Promise.all(batch.map(results));
          batch.forEach((id, j) => {
            const state = detection.get(id);
            readings.set(id, {
              state: state?.state ?? "unknown",
              enteredAt: state?.enteredAt ?? 0,
              results: recent[j] ?? [],
            });
          });
        }
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
      }
      return readings;
    },
  };
}
