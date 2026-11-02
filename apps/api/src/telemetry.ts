import { ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { MonitorId, MonitorState, RecentResult } from "@galena/contracts";
import {
  type MinuteCounts,
  mergeMinutes,
  monthSpan,
  pointOf,
  type SeriesPoint,
  type SeriesWindow,
} from "@galena/core";
import { minutesOf, monitorKey, regionRollupOf, spanKeys } from "@galena/integrations/telemetry";

/** Scheduled minutes of results the dashboard shows per monitor. */
export const RECENT_MINUTES = 60;

export type MonitorReading = {
  state: MonitorState;
  /** Epoch ms; 0 before the first check. */
  enteredAt: number;
  /** Newest first. */
  results: RecentResult[];
};

/** A chart point with the span it covers and its region. */
export type PointAt = SeriesPoint & { at: string; region: string };

/** Reads what the evaluator and the rollup write; the API never writes telemetry. */
export type Telemetry = {
  regions: readonly string[];
  read(ids: readonly MonitorId[]): Promise<Map<MonitorId, MonitorReading>>;
  /** A chart's points: hour or day rollups, as the window says. */
  series(id: MonitorId, window: SeriesWindow): Promise<PointAt[]>;
  /** A month's minutes (`YYYY-MM`): its rolled-up days, and today's hours while it is today's. */
  minutes(id: MonitorId, month: string, today: string): Promise<MinuteCounts>;
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
      const keys = ids.slice(i, i + 100).map((id) => ({ pk: monitorKey(id), sk: "STATE" }));
      const { Responses, UnprocessedKeys } = await doc.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }),
      );
      if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
        throw new Error("DynamoDB left monitor states unread; reload to try again.");
      }
      for (const item of Responses?.[table] ?? []) {
        found.set(String(item.pk), item.detection);
      }
    }
    return found;
  }

  async function results(id: MonitorId): Promise<RecentResult[]> {
    const { Items = [] } = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :results)",
        ExpressionAttributeValues: { ":pk": monitorKey(id), ":results": "R#" },
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

  /** Every item of one kind in a span, page by page; a missing table reads as none. */
  async function span(id: MonitorId, keys: { from: string; to: string }) {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    try {
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
            ExpressionAttributeValues: {
              ":pk": monitorKey(id),
              ":from": keys.from,
              ":to": keys.to,
            },
            ExclusiveStartKey: start,
          }),
        );
        items.push(...(page.Items ?? []));
        start = page.LastEvaluatedKey;
      } while (start);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
    return items;
  }

  return {
    regions,
    async series(id, { source, from, to }) {
      const prefix = source === "hour" ? "H" : "D";
      return (await span(id, spanKeys(prefix, from, to))).map((item) => {
        const { at, region, rollup } = regionRollupOf(item);
        return { at, region, ...pointOf(rollup) };
      });
    },
    async minutes(id, month, today) {
      const { days } = monthSpan(month);
      const items = await span(id, spanKeys("UD", days.from, days.to));
      // Today has no day rollup until after midnight; its hours stand in for it meanwhile.
      if (today >= days.from && today <= days.to) {
        items.push(...(await span(id, spanKeys("UH", `${today}T00`, `${today}T23`))));
      }
      return items.map(minutesOf).reduce<MinuteCounts>(mergeMinutes, { minutes: 0, down: 0 });
    },
    async read(ids) {
      const readings = new Map<MonitorId, MonitorReading>();
      try {
        const detection = await states(ids);
        // A few monitors at a time: each query reads up to an hour of results.
        for (let i = 0; i < ids.length; i += 10) {
          const batch = ids.slice(i, i + 10);
          const recent = await Promise.all(batch.map(results));
          batch.forEach((id, j) => {
            const state = detection.get(monitorKey(id));
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
