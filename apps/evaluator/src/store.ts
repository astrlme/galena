import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  type CheckResult,
  type MonitorId,
  type MonitorTransitioned,
  monitorId,
  PING_KEY,
  type StoredPing,
  storedPing,
} from "@galena/contracts";
import type { CanaryTrack, DetectionState } from "@galena/core";

// The telemetry table (one table, `pk` + `sk`): check results, monitor state, region health,
// and heartbeat check-ins, which the API writes.

const RESULT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The monitor state item, `MON#<monitorId>` / `STATE`. */
export type MonitorRecord = {
  detection: DetectionState;
  /** Every write expects the version it read, so concurrent deliveries can't both win. */
  version: number;
  /** Per region, the scheduled minute (epoch ms) last applied; redeliveries at or before it are skipped. */
  applied: Record<string, number>;
  /** Transitions written but perhaps not yet triggered; the next delivery triggers them again. */
  pending: MonitorTransitioned[];
};

/** The region health item, `REGION#<region>` / `HEALTH`. */
export type RegionHealth = CanaryTrack & { lastScheduledAt: number };

export class VersionConflictError extends Error {
  override name = "VersionConflictError";
}

export function createStore(doc: DynamoDBDocumentClient, table: string) {
  const stateKey = (id: MonitorId) => ({ pk: `MON#${id}`, sk: "STATE" });
  const healthKey = (region: string) => ({ pk: `REGION#${region}`, sk: "HEALTH" });

  return {
    /** Idempotent: a redelivered result overwrites itself. */
    async putResult({ monitorId, region, scheduledAt, ...fields }: CheckResult) {
      const ttl = Math.floor(Date.parse(scheduledAt) / 1000) + RESULT_TTL_SECONDS;
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { pk: `MON#${monitorId}`, sk: `R#${scheduledAt}#${region}`, ...fields, ttl },
        }),
      );
    },

    async getMonitor(id: MonitorId): Promise<MonitorRecord | undefined> {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: stateKey(id), ConsistentRead: true }),
      );
      if (!Item) return undefined;
      const { pk: _, sk: __, ...record } = Item;
      return record as MonitorRecord; // our own item, written by `putMonitor`
    },

    /** Writes only if the stored version is still `expected` (null: no item yet). */
    async putMonitor(id: MonitorId, record: MonitorRecord, expected: number | null) {
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: { ...stateKey(id), ...record },
            ConditionExpression: expected === null ? "attribute_not_exists(pk)" : "#v = :v",
            ...(expected === null
              ? {}
              : {
                  ExpressionAttributeNames: { "#v": "version" },
                  ExpressionAttributeValues: { ":v": expected },
                }),
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new VersionConflictError(`Monitor ${id} changed since version ${expected}.`);
        }
        throw error;
      }
    },

    async getRegionHealth(regions: readonly string[]): Promise<Map<string, RegionHealth>> {
      // The heartbeat sweep has no probe regions; BatchGetItem refuses an empty list.
      if (regions.length === 0) return new Map();
      const { Responses, UnprocessedKeys } = await doc.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: regions.map(healthKey) } } }),
      );
      if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
        throw new Error("DynamoDB left region health unread; the batch will be retried.");
      }
      return new Map(
        (Responses?.[table] ?? []).map(({ pk, sk: _, ...health }) => [
          String(pk).slice("REGION#".length),
          health as RegionHealth,
        ]),
      );
    },

    /** Each heartbeat monitor's newest check-in; one without any yet is absent. */
    async getPings(ids: readonly MonitorId[]): Promise<Map<MonitorId, StoredPing>> {
      const pings = new Map<MonitorId, StoredPing>();
      // BatchGetItem takes 100 keys; the monitor cap keeps this to one call.
      for (let i = 0; i < ids.length; i += 100) {
        const { Responses, UnprocessedKeys } = await doc.send(
          new BatchGetCommand({
            RequestItems: {
              [table]: {
                Keys: ids.slice(i, i + 100).map((id) => ({ pk: `MON#${id}`, sk: PING_KEY })),
              },
            },
          }),
        );
        if (Object.keys(UnprocessedKeys ?? {}).length > 0) {
          throw new Error("DynamoDB left check-ins unread; the sweep will be retried.");
        }
        for (const { pk, ...item } of Responses?.[table] ?? []) {
          // One malformed item must not stop every other heartbeat: that one just waits.
          const ping = storedPing.safeParse(item);
          if (ping.success) pings.set(monitorId.parse(String(pk).slice("MON#".length)), ping.data);
        }
      }
      return pings;
    },

    async putRegionHealth(region: string, health: RegionHealth) {
      await doc.send(
        new PutCommand({ TableName: table, Item: { ...healthKey(region), ...health } }),
      );
    },
  };
}

export type Store = ReturnType<typeof createStore>;
