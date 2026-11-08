import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { MonitorId, MonitorsFile } from "@galena/contracts";
import {
  type Clock,
  dayKey,
  hourKey,
  mergeRollups,
  type Rollup,
  rollUp,
  summarize,
  summaryWindow,
} from "@galena/core";
import {
  DAY_TTL_SECONDS,
  HOUR_TTL_SECONDS,
  minutesDayKey,
  minutesHourKey,
  minutesOf,
  monitorKey,
  rawCheckOf,
  regionDayKey,
  regionHourKey,
  regionRollupOf,
  SUMMARY_KEY,
  spanKeys,
} from "@galena/integrations/telemetry";
import { writeBatches } from "./batch-write.ts";

type Item = Record<string, unknown>;

/** The telemetry table as the rollup uses it: one monitor's span of items, and writes. */
export type TelemetryStore = {
  query(pk: string, span: { from: string; to: string }): Promise<Item[]>;
  write(items: Item[]): Promise<void>;
};

/** A monitor to roll up, from `monitors.json`: no database read, so Aurora stays paused. */
export type MonitorToRoll = { id: MonitorId; quorum: number };

/** What the rollup needs of each monitor in `monitors.json`. */
export const toRoll = (file: Pick<MonitorsFile, "monitors">): MonitorToRoll[] =>
  file.monitors.map((m) => ({ id: m.id, quorum: m.detection.quorum }));

const HOUR = 60 * 60 * 1000;
const empty = (): Rollup => ({ regions: new Map(), minutes: { minutes: 0, down: 0 } });

/**
 * Rolls the hour before `clock` up for every monitor, then its summary; the run after midnight
 * also rolls up the day that just ended. Every item is written whole under a key fixed by its
 * hour or day, so a retried or repeated run writes the same items again.
 */
export async function rollUpTelemetry(deps: {
  clock: Clock;
  store: TelemetryStore;
  monitors: () => Promise<MonitorToRoll[]>;
}): Promise<{ hour: string; monitors: number; day: string | null }> {
  const now = deps.clock.now().getTime();
  const start = Math.floor(now / HOUR) * HOUR - HOUR;
  const day = new Date(start).getUTCHours() === 23 ? dayKey(start) : null;
  const monitors = await deps.monitors();
  for (const monitor of monitors) {
    const last = await rollUpHour(deps.store, monitor, start, now);
    // Known limit: a monitor paused or removed before midnight keeps its hours but gets no day;
    // that needs the list of every monitor that ran that day, not today's.
    if (day) {
      // The earlier hours were written an hour or more ago. The last, milliseconds ago, is
      // merged as rolled up rather than read back from an eventually consistent query.
      const pk = monitorKey(monitor.id);
      const earlier = await storedHours(deps.store, pk, `${day}T00`, `${day}T22`);
      await writeDay(deps.store, pk, day, mergeRollups(earlier, last));
    }
    await writeSummary(deps.store, monitor, start, last);
  }
  return { hour: hourKey(start), monitors: monitors.length, day };
}

/**
 * Rolls a whole day up from its raw checks, for the backfill: each hour still inside its 30 days
 * is written too, and the day from all 24.
 */
export async function rollUpDay(
  store: TelemetryStore,
  monitor: MonitorToRoll,
  day: string,
  now: number,
): Promise<void> {
  let whole = empty();
  for (let h = 0; h < 24; h++) {
    const start = Date.parse(`${day}T00:00:00.000Z`) + h * HOUR;
    whole = mergeRollups(whole, await rollUpHour(store, monitor, start, now));
  }
  await writeDay(store, monitorKey(monitor.id), day, whole);
}

/** Rolls the hour from `start` up from its raw checks, and writes it unless it has expired. */
export async function rollUpHour(
  store: TelemetryStore,
  monitor: MonitorToRoll,
  start: number,
  now: number,
): Promise<Rollup> {
  const pk = monitorKey(monitor.id);
  const hour = hourKey(start);
  const checks = (await store.query(pk, spanKeys("R", hour, hour))).map(rawCheckOf);
  if (checks.length === 0) return empty();
  const rollup = rollUp(checks, monitor.quorum);
  const ttl = Math.floor(start / 1000) + HOUR_TTL_SECONDS;
  if (ttl * 1000 > now) {
    await store.write([
      ...[...rollup.regions].map(([region, r]) => ({
        pk,
        sk: regionHourKey(hour, region),
        ...r,
        ttl,
      })),
      { pk, sk: minutesHourKey(hour), ...rollup.minutes, ttl },
    ]);
  }
  return rollup;
}

/**
 * Writes the monitor's summary to the hour from `start`, whose rollup `last` is passed in as just
 * rolled up; the rest is read back. Nothing is written while it has no checks in the 30 days.
 * Known limit: one `SUMMARY` key, replaced whole, so a retry of an older hour that runs after a
 * newer one puts the older summary back until the next run; a conditional put on `through` would
 * stop it.
 */
export async function writeSummary(
  store: TelemetryStore,
  monitor: MonitorToRoll,
  start: number,
  last: Rollup,
): Promise<void> {
  const pk = monitorKey(monitor.id);
  const window = summaryWindow(start);
  const hours = [
    ...(await store.query(pk, spanKeys("H", window.hours.from, window.hours.to))).map(
      regionRollupOf,
    ),
    ...[...last.regions].map(([region, rollup]) => ({ at: hourKey(start), region, rollup })),
  ];
  const minutes = [
    ...(await store.query(pk, spanKeys("UD", window.days.from, window.days.to))).map(minutesOf),
    ...(window.today
      ? (await store.query(pk, spanKeys("UH", window.today.from, window.today.to))).map(minutesOf)
      : []),
    last.minutes,
  ];
  if (hours.length === 0 && minutes.every((m) => m.minutes === 0)) return;
  await store.write([{ pk, sk: SUMMARY_KEY, ...summarize(start, hours, minutes) }]);
}

async function storedHours(store: TelemetryStore, pk: string, from: string, to: string) {
  const regions = (await store.query(pk, spanKeys("H", from, to))).map(regionRollupOf);
  const minutes = (await store.query(pk, spanKeys("UH", from, to))).map(minutesOf);
  return [
    ...regions.map(({ region, rollup }) => ({ ...empty(), regions: new Map([[region, rollup]]) })),
    ...minutes.map((m) => ({ ...empty(), minutes: m })),
  ].reduce<Rollup>(mergeRollups, empty());
}

async function writeDay(store: TelemetryStore, pk: string, day: string, rollup: Rollup) {
  if (rollup.regions.size === 0 && rollup.minutes.minutes === 0) return;
  const ttl = Math.floor(Date.parse(day) / 1000) + DAY_TTL_SECONDS;
  await store.write([
    ...[...rollup.regions].map(([region, r]) => ({ pk, sk: regionDayKey(day, region), ...r, ttl })),
    { pk, sk: minutesDayKey(day), ...rollup.minutes, ttl },
  ]);
}

/** The rollup's reads and writes on the telemetry table, paged and batched. */
export function dynamoTelemetryStore(doc: DynamoDBDocumentClient, table: string): TelemetryStore {
  return {
    async query(pk, { from, to }) {
      const items: Item[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
            ExpressionAttributeValues: { ":pk": pk, ":from": from, ":to": to },
            ExclusiveStartKey: start,
          }),
        );
        items.push(...(page.Items ?? []));
        start = page.LastEvaluatedKey;
      } while (start);
      return items;
    },
    async write(items) {
      await writeBatches(
        doc,
        table,
        items.map((Item) => ({ PutRequest: { Item } })),
      );
    },
  };
}
