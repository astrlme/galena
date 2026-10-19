import {
  type ChannelKind,
  type ComponentId,
  type DeliveryId,
  type DeliveryStatus,
  deliveryId,
  type EndpointKind,
  type EndpointState,
  type EventId,
  type Notice,
  type SubscriberId,
  type SubscriberState,
  type WebhookEndpointId,
  type WorkspaceId,
} from "@galena/contracts";
import type { EndpointHealth } from "@galena/core";
import { and, asc, count, desc, eq, gte, lt, lte, ne, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { delivery, subscriber, webhookEndpoint } from "../schema/index.ts";

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

/** Confirmation emails sent since `since`, across the workspace: the form's overall cap. */
export async function countConfirmationsSince(
  db: Db,
  workspaceId: WorkspaceId,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriber)
    .where(and(eq(subscriber.workspaceId, workspaceId), gte(subscriber.confirmSentAt, since)));
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
 * are, so running the fan-out again changes nothing. An endpoint's row keeps its notice.
 */
export async function recordDeliveries(
  db: Db,
  event: { workspaceId: WorkspaceId; eventId: EventId; subjectId: string },
  targets: ReadonlyArray<DeliveryTarget & { channel: ChannelKind; notice?: Notice }>,
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
 * Claims a pending delivery for one attempt of its send (from 1). Runs on the same attempt
 * exclude each other whichever reads first; a retry, with a higher number, claims it again.
 * `retake`: the queue handed the same attempt over again because the run that claimed it died.
 */
export async function claimDelivery(
  db: Db,
  id: DeliveryId,
  attempt: number,
  retake = false,
): Promise<boolean> {
  const rows = await db
    .update(delivery)
    .set({ attempts: attempt })
    .where(
      and(
        eq(delivery.id, id),
        (retake ? lte : lt)(delivery.attempts, attempt),
        sql`${delivery.status}::text = 'pending'`,
      ),
    )
    .returning({ id: delivery.id });
  return rows.length === 1;
}

/** An attempt failed and the next one is scheduled: the delivery stays pending, saying why. */
export async function noteDeliveryError(db: Db, id: DeliveryId, lastError: string) {
  await db
    .update(delivery)
    .set({ lastError })
    .where(and(eq(delivery.id, id), sql`${delivery.status}::text = 'pending'`));
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

const endpointColumns = {
  id: webhookEndpoint.id,
  workspaceId: webhookEndpoint.workspaceId,
  kind: webhookEndpoint.kind,
  name: webhookEndpoint.name,
  state: webhookEndpoint.state,
  componentIds: webhookEndpoint.componentIds,
  failingSince: webhookEndpoint.failingSince,
  createdAt: webhookEndpoint.createdAt,
};
/** An endpoint as members see it: never its URL or secret. */
export type EndpointRow = {
  id: WebhookEndpointId;
  workspaceId: WorkspaceId;
  kind: EndpointKind;
  name: string;
  state: EndpointState;
  componentIds: ComponentId[];
  failingSince: Date | null;
  createdAt: Date;
};

export function listEndpoints(db: Db, workspaceId: WorkspaceId): Promise<EndpointRow[]> {
  return db
    .select(endpointColumns)
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.workspaceId, workspaceId))
    .orderBy(asc(webhookEndpoint.createdAt), asc(webhookEndpoint.id));
}

export async function createEndpoint(
  db: Db,
  row: Pick<EndpointRow, "id" | "workspaceId" | "kind" | "name" | "componentIds"> & {
    urlSealed: string;
    secretSealed: string | null;
  },
): Promise<void> {
  await db.insert(webhookEndpoint).values(row);
}

export async function deleteEndpoint(
  db: Db,
  workspaceId: WorkspaceId,
  id: WebhookEndpointId,
): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoint)
    .where(and(eq(webhookEndpoint.workspaceId, workspaceId), eq(webhookEndpoint.id, id)))
    .returning({ id: webhookEndpoint.id });
  return rows.length === 1;
}

/** Endpoints that should hear about the workspace's events: all but disabled ones. */
export function listDeliverableEndpoints(db: Db, workspaceId: WorkspaceId) {
  return db
    .select({
      id: webhookEndpoint.id,
      kind: webhookEndpoint.kind,
      componentIds: webhookEndpoint.componentIds,
    })
    .from(webhookEndpoint)
    .where(
      and(
        eq(webhookEndpoint.workspaceId, workspaceId),
        sql`${webhookEndpoint.state}::text <> 'disabled'`,
      ),
    );
}

/** What a send needs: the sealed URL and secret, which only the workers open. */
export async function findEndpointForSend(db: Db, id: WebhookEndpointId) {
  const [row] = await db
    .select({
      id: webhookEndpoint.id,
      kind: webhookEndpoint.kind,
      state: webhookEndpoint.state,
      failingSince: webhookEndpoint.failingSince,
      urlSealed: webhookEndpoint.urlSealed,
      secretSealed: webhookEndpoint.secretSealed,
    })
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.id, id));
  return row;
}

/**
 * Moves an endpoint on from the state it was read in (compare-and-set). False when something
 * else moved it first, such as a member turning it on.
 */
export async function setEndpointHealth(
  db: Db,
  id: WebhookEndpointId,
  from: EndpointState,
  to: EndpointHealth,
): Promise<boolean> {
  const rows = await db
    .update(webhookEndpoint)
    .set(to)
    .where(and(eq(webhookEndpoint.id, id), sql`${webhookEndpoint.state}::text = ${from}`))
    .returning({ id: webhookEndpoint.id });
  return rows.length === 1;
}

/** An endpoint's delivery log, newest first. Known limit: the last 50. */
export function listEndpointDeliveries(
  db: Db,
  workspaceId: WorkspaceId,
  endpointId: WebhookEndpointId,
) {
  return db
    .select({
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.lastError,
      sentAt: delivery.sentAt,
      createdAt: delivery.createdAt,
      kind: sql<string | null>`${delivery.notice}->>'kind'`,
      title: sql<string | null>`${delivery.notice}->>'title'`,
    })
    .from(delivery)
    .where(and(eq(delivery.workspaceId, workspaceId), eq(delivery.endpointId, endpointId)))
    .orderBy(desc(delivery.createdAt), desc(delivery.id))
    .limit(50);
}

/** One of an endpoint's deliveries, with its notice, for sending it again. */
export async function findEndpointDelivery(
  db: Db,
  workspaceId: WorkspaceId,
  endpointId: WebhookEndpointId,
  id: DeliveryId,
) {
  const [row] = await db
    .select({ id: delivery.id, status: delivery.status, notice: delivery.notice })
    .from(delivery)
    .where(
      and(
        eq(delivery.workspaceId, workspaceId),
        eq(delivery.endpointId, endpointId),
        eq(delivery.id, id),
      ),
    );
  return row;
}

/**
 * A member sent a settled delivery again: it records how that went, as one more attempt. A
 * delivery still pending is left to its own retries.
 */
export async function settleResend(
  db: Db,
  id: DeliveryId,
  outcome: { status: "sent"; sentAt: Date } | { status: "failed"; lastError: string },
): Promise<boolean> {
  const rows = await db
    .update(delivery)
    .set({
      ...outcome,
      ...(outcome.status === "sent" && { lastError: null }),
      attempts: sql`${delivery.attempts} + 1`,
    })
    .where(and(eq(delivery.id, id), sql`${delivery.status}::text <> 'pending'`))
    .returning({ id: delivery.id });
  return rows.length === 1;
}

/** For the dashboard: newest first. Known limit: the first 500; paginate when lists grow. */
export function listSubscribers(db: Db, workspaceId: WorkspaceId) {
  return db
    .select({ ...subscriberColumns, createdAt: subscriber.createdAt })
    .from(subscriber)
    .where(eq(subscriber.workspaceId, workspaceId))
    .orderBy(desc(subscriber.createdAt), desc(subscriber.id))
    .limit(500);
}

export async function deleteSubscriber(
  db: Db,
  workspaceId: WorkspaceId,
  id: SubscriberId,
): Promise<boolean> {
  const rows = await db
    .delete(subscriber)
    .where(and(eq(subscriber.workspaceId, workspaceId), eq(subscriber.id, id)))
    .returning({ id: subscriber.id });
  return rows.length === 1;
}
