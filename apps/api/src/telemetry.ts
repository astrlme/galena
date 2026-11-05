import { ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  MonitorDay,
  MonitorId,
  MonitorState,
  MonitorSummary,
  RecentCheck,
  RecentResult,
} from "@galena/contracts";
import {
  dayKey,
  type MinuteCounts,
  mergeMinutes,
  monthSpan,
  ninetyDays,
  type PointAt,
  type SeriesWindow,
  seriesOf,
  type Total,
} from "@galena/core";
import {
  minutesOf,
  monitorKey,
  regionRollupOf,
  SUMMARY_KEY,
  spanKeys,
  summaryOf,
} from "@galena/integrations/telemetry";

/** Scheduled minutes of results a reading has unless fewer are asked for. */
export const RECENT_MINUTES = 60;

export type MonitorReading = {
  state: MonitorState;
  /** Epoch ms; 0 before the first check. */
  enteredAt: number;
  /** Newest first. */
  results: RecentResult[];
  /** Written by the hourly rollup; null before it has seen a check. */
  summary: MonitorSummary | null;
};

/** Reads what the evaluator and the rollup write; the API never writes telemetry. */
export type Telemetry = {
  regions: readonly string[];
  /** Each monitor's state, summary and newest `minutes` of results. */
  read(ids: readonly MonitorId[], minutes: number): Promise<Map<MonitorId, MonitorReading>>;
  /** A chart's points and totals, from hour or day rollups as the window says. */
  series(id: MonitorId, window: SeriesWindow): Promise<{ points: PointAt[]; totals: Total[] }>;
  /** A chart window's minutes checked and down: a small item an hour or a day. */
  uptime(id: MonitorId, window: SeriesWindow): Promise<MinuteCounts>;
  /** A month's minutes (`YYYY-MM`): its rolled-up days, and today's hours while it is today's. */
  minutes(id: MonitorId, month: string, today: string): Promise<MinuteCounts>;
  /** The 90 days to `today` (`YYYY-MM-DD`), oldest first; see `ninetyDays`. */
  days(id: MonitorId, today: string): Promise<MonitorDay[]>;
  /** One monitor's results scheduled since `since` (60 minutes at most), newest first, with errors. */
  checks(id: MonitorId, since: string): Promise<RecentCheck[]>;
};

const DAY = 86_400_000;

/**
 * `MON#<id>` / `STATE` for the detection state, `SUMMARY` for the hourly summary and
 * `R#<minute>#<region>` for results. A missing table reads as no data: locally it appears when
 * the hot path first runs.
 */
export function dynamoTelemetry(
  doc: DynamoDBDocumentClient,
  table: string,
  regions: readonly string[],
): Telemetry {
  /** Each monitor's `STATE` and `SUMMARY` items, keyed by partition key. */
  async function statesAndSummaries(ids: readonly MonitorId[]) {
    const states = new Map<string, { state: MonitorState; enteredAt: number }>();
    const summaries = new Map<string, MonitorSummary>();
    // Two keys a monitor, and BatchGetItem takes 100 keys.
    for (let i = 0; i < ids.length; i += 50) {
      const keys = ids.slice(i, i + 50).flatMap((id) => [
        { pk: monitorKey(id), sk: "STATE" },
        { pk: monitorKey(id), sk: SUMMARY_KEY },
      ]);
      const { Responses, UnprocessedKeys } = await doc.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }),
      );
      if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
        throw new Error("DynamoDB left monitor states unread; reload to try again.");
      }
      for (const item of Responses?.[table] ?? []) {
        if (item.sk === SUMMARY_KEY) summaries.set(String(item.pk), summaryOf(item));
        else states.set(String(item.pk), item.detection);
      }
    }
    return { states, summaries };
  }

  async function results(id: MonitorId, count: number): Promise<RecentCheck[]> {
    const { Items = [] } = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :results)",
        ExpressionAttributeValues: { ":pk": monitorKey(id), ":results": "R#" },
        ScanIndexForward: false,
        Limit: count * regions.length,
      }),
    );
    // A region that missed minutes leaves room for older ones; keep the newest minutes only.
    const minutes = new Set<string>();
    const recent: RecentCheck[] = [];
    for (const item of Items) {
      const [, scheduledAt = "", region = ""] = String(item.sk).split("#");
      minutes.add(scheduledAt);
      if (minutes.size > count) break;
      recent.push({
        region,
        scheduledAt,
        status: item.status,
        latencyMs: item.latencyMs ?? null,
        error: item.error ?? null,
      });
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
      return seriesOf((await span(id, spanKeys(prefix, from, to))).map(regionRollupOf));
    },
    async uptime(id, { source, from, to }) {
      return (await span(id, spanKeys(source === "hour" ? "UH" : "UD", from, to)))
        .map(minutesOf)
        .reduce<MinuteCounts>(mergeMinutes, { minutes: 0, down: 0 });
    },
    async days(id, today) {
      const end = Date.parse(`${today}T00:00:00.000Z`);
      const first = dayKey(end - 89 * DAY);
      const yesterday = dayKey(end - DAY);
      const [dayItems, hourItems] = await Promise.all([
        span(id, spanKeys("UD", first, yesterday)),
        // Today's hours, and yesterday's until its day rollup lands after midnight.
        span(id, spanKeys("UH", `${yesterday}T00`, `${today}T23`)),
      ]);
      const stored = new Map(dayItems.map((item) => [String(item.sk).slice(3), minutesOf(item)]));
      const hours = new Map<string, MinuteCounts>();
      for (const item of hourItems) {
        const date = String(item.sk).slice(3, 13);
        hours.set(date, mergeMinutes(hours.get(date) ?? { minutes: 0, down: 0 }, minutesOf(item)));
      }
      return ninetyDays(today, stored, hours);
    },
    async checks(id, since) {
      try {
        // The newest results, however old: only the ones in the last hour count as its own.
        return (await results(id, RECENT_MINUTES)).filter((r) => r.scheduledAt >= since);
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
        return [];
      }
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
    async read(ids, minutes) {
      const readings = new Map<MonitorId, MonitorReading>();
      try {
        const { states, summaries } = await statesAndSummaries(ids);
        // A few monitors at a time: each query reads up to an hour of results.
        for (let i = 0; i < ids.length; i += 10) {
          const batch = ids.slice(i, i + 10);
          const recent = await Promise.all(batch.map((id) => results(id, minutes)));
          batch.forEach((id, j) => {
            const state = states.get(monitorKey(id));
            readings.set(id, {
              state: state?.state ?? "unknown",
              enteredAt: state?.enteredAt ?? 0,
              // The list shows states, not errors.
              results: (recent[j] ?? []).map(({ error: _, ...result }): RecentResult => result),
              summary: summaries.get(monitorKey(id)) ?? null,
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
