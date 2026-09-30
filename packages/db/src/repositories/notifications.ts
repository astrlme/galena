import {
  type ChannelKind,
  type ComponentId,
  type DeliveryId,
  type DeliveryStatus,
  deliveryId,
  type EventId,
  type SubscriberId,
  type SubscriberState,
  type WebhookEndpointId,
  type WorkspaceId,
} from "@galena/contracts";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { delivery, subscriber } from "../schema/index.ts";

const subscriberColumns = {
  id: subscriber.id,
  workspaceId: subscriber.workspaceId,
  email: subscriber.email,
  state: subscriber.state,
  componentIds: subscriber.componentIds,
  confirmSentAt: subscriber.confirmSentAt,
};
export type SubscriberRow = {
  id: SubscriberId;
  workspaceId: WorkspaceId;
  email: string;
  state: SubscriberState;
  componentIds: ComponentId[];
  confirmSentAt: Date | null;
};

export async function findSubscriberByEmail(
  db: Db,
  workspaceId: WorkspaceId,
  email: string,
): Promise<SubscriberRow | undefined> {
  const [row] = await db
    .select(subscriberColumns)
    .from(subscriber)
    .where(and(eq(subscriber.workspaceId, workspaceId), eq(subscriber.email, email)))
    .limit(1);
  return row;
}

/** By id alone: confirm and unsubscribe links carry the id, signed. */
export async function findSubscriber(db: Db, id: SubscriberId): Promise<SubscriberRow | undefined> {
  const [row] = await db.select(subscriberColumns).from(subscriber).where(eq(subscriber.id, id));
  return row;
}

/** Inserts the address or, when it is known, applies the new state (the email stays). */
export async function saveSubscriber(
  db: Db,
  row: SubscriberRow & { ipHash: string | null },
): Promise<SubscriberId> {
  const { id, workspaceId, email, ...fields } = row;
  const [saved] = await db
    .insert(subscriber)
    .values(row)
    .onConflictDoUpdate({ target: [subscriber.workspaceId, subscriber.email], set: fields })
    .returning({ id: subscriber.id });
  return saved?.id ?? id;
}

/** Moves the state; `confirmedAt` when it becomes active. */
export async function setSubscriberState(
  db: Db,
  id: SubscriberId,
  state: SubscriberState,
  confirmedAt?: Date,
): Promise<void> {
  await db
    .update(subscriber)
    .set({ state, ...(confirmedAt ? { confirmedAt } : {}) })
    .where(eq(subscriber.id, id));
}

/** Suppresses an address everywhere, after SES reported a hard bounce or a complaint. */
export async function suppressSubscriber(db: Db, email: string): Promise<number> {
  const rows = await db
    .update(subscriber)
    .set({ state: "suppressed" })
    .where(eq(subscriber.email, email))
    .returning({ id: subscriber.id });
  return rows.length;
}

/** How many addresses were submitted from this network since `since`, for the form's limit. */
export async function countSubscribersFromIp(db: Db, ipHash: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriber)
    .where(and(eq(subscriber.ipHash, ipHash), gte(subscriber.createdAt, since)));
  return row?.n ?? 0;
}

/** Everyone who should hear about the workspace's events: confirmed, not unsubscribed. */
export function listActiveSubscribers(db: Db, workspaceId: WorkspaceId) {
  return db
    .select({ id: subscriber.id, componentIds: subscriber.componentIds })
    .from(subscriber)
    .where(and(eq(subscriber.workspaceId, workspaceId), sql`${subscriber.state}::text = 'active'`));
}

export type DeliveryTarget = { subscriberId: SubscriberId } | { endpointId: WebhookEndpointId };

/**
 * Records one pending delivery per target for the event. Rows that exist already stay as they
 * are, so running the fan-out again changes nothing.
 */
export async function recordDeliveries(
  db: Db,
  event: { workspaceId: WorkspaceId; eventId: EventId; subjectId: string },
  targets: ReadonlyArray<DeliveryTarget & { channel: ChannelKind }>,
): Promise<void> {
  if (targets.length === 0) return;
  await db
    .insert(delivery)
    .values(targets.map((t) => ({ id: deliveryId.parse(v7()), ...event, ...t })))
    .onConflictDoNothing();
}

const deliveryColumns = { id: delivery.id, status: delivery.status, attempts: delivery.attempts };

export async function findDelivery(db: Db, eventId: EventId, target: DeliveryTarget) {
  const byTarget =
    "subscriberId" in target
      ? eq(delivery.subscriberId, target.subscriberId)
      : eq(delivery.endpointId, target.endpointId);
  const [row] = await db
    .select(deliveryColumns)
    .from(delivery)
    .where(and(eq(delivery.eventId, eventId), byTarget))
    .limit(1);
  return row;
}

/**
 * Settles a pending delivery. False when it had already settled, which tells a retried send
 * that an earlier attempt got there first.
 */
export async function settleDelivery(
  db: Db,
  id: DeliveryId,
  outcome: {
    status: Exclude<DeliveryStatus, "pending">;
    attempts: number;
    providerId?: string;
    lastError?: string;
    sentAt?: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(delivery)
    .set(outcome)
    .where(and(eq(delivery.id, id), sql`${delivery.status}::text = 'pending'`))
    .returning({ id: delivery.id });
  return rows.length === 1;
}

/** Whether an earlier event about the same incident or window already reached anyone. */
export async function wasAnnounced(
  db: Db,
  workspaceId: WorkspaceId,
  subjectId: string,
  eventId: EventId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: delivery.id })
    .from(delivery)
    .where(
      and(
        eq(delivery.workspaceId, workspaceId),
        eq(delivery.subjectId, subjectId),
        ne(delivery.eventId, eventId),
      ),
    )
    .limit(1);
  return row !== undefined;
}
