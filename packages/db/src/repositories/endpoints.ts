import type {
  ComponentId,
  DeliveryId,
  EndpointKind,
  EndpointState,
  NoticeKind,
  WebhookEndpointId,
  WorkspaceId,
} from "@galena/contracts";
import type { EndpointHealth } from "@galena/core";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { delivery, webhookEndpoint } from "../schema/index.ts";

// Slack and webhook endpoints a member added, and the log of what each was sent.

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
 * Moves an endpoint on from the health it was read with (compare-and-set). False when something
 * else moved it first, such as a member turning it on, or another delivery.
 */
export async function setEndpointHealth(
  db: Db,
  id: WebhookEndpointId,
  from: EndpointHealth,
  to: EndpointHealth,
): Promise<boolean> {
  const rows = await db
    .update(webhookEndpoint)
    .set(to)
    .where(
      and(
        eq(webhookEndpoint.id, id),
        sql`${webhookEndpoint.state}::text = ${from.state}`,
        from.failingSince
          ? eq(webhookEndpoint.failingSince, from.failingSince)
          : isNull(webhookEndpoint.failingSince),
      ),
    )
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
      kind: sql<NoticeKind | null>`${delivery.notice}->>'kind'`,
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
    .select({
      id: delivery.id,
      status: delivery.status,
      attempts: delivery.attempts,
      updatedAt: delivery.updatedAt,
      notice: delivery.notice,
    })
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
 * Claims a delivery for one resend, as one more attempt, before anything is posted. It is
 * pending while the post runs, so a second press waits; of two read at the same count, one
 * claims it, and a late retry finds the count taken.
 */
export async function claimResend(db: Db, id: DeliveryId, readAttempts: number) {
  const rows = await db
    .update(delivery)
    .set({ status: "pending", attempts: readAttempts + 1 })
    .where(and(eq(delivery.id, id), eq(delivery.attempts, readAttempts)))
    .returning({ attempts: delivery.attempts });
  return rows[0]?.attempts;
}

/** Records how the resend that claimed `attempts` went. */
export async function settleResend(
  db: Db,
  id: DeliveryId,
  attempts: number,
  outcome: { status: "sent"; sentAt: Date } | { status: "failed"; lastError: string },
): Promise<void> {
  await db
    .update(delivery)
    .set({ ...outcome, ...(outcome.status === "sent" && { lastError: null }) })
    .where(and(eq(delivery.id, id), eq(delivery.attempts, attempts)));
}
