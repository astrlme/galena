import { auditLogId, type EventEnvelope, outboxId, type WorkspaceId } from "@galena/contracts";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { auditLog, outbox } from "../schema/index.ts";

export type Change = {
  workspaceId: WorkspaceId;
  /** Who did it; null for the system. */
  actorUserId: string | null;
  /** What the audit log shows, e.g. "component.created". */
  action: string;
  targetType: string;
  targetId: string | null;
  data?: unknown;
  /** The domain event consumers act on. */
  event: EventEnvelope<string, unknown>;
};

/**
 * Writes the audit entry and the outbox event for one change. Call it inside the same
 * transaction as the change itself, so neither can exist without the other.
 */
export async function recordChange(db: Db, change: Change): Promise<void> {
  await db.insert(auditLog).values({
    id: auditLogId.parse(v7()),
    workspaceId: change.workspaceId,
    actorUserId: change.actorUserId,
    action: change.action,
    targetType: change.targetType,
    targetId: change.targetId,
    data: change.data ?? null,
  });
  await db.insert(outbox).values({
    id: outboxId.parse(v7()),
    workspaceId: change.workspaceId,
    eventType: change.event.type,
    payload: change.event,
  });
}
