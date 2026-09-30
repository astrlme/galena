import { type ChangeAction, eventId, type OutboxId } from "@galena/contracts";
import { type Change, type Db, recordChange } from "@galena/db";
import type { z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import type { Deps, Member } from "../http.ts";

// Route helpers shared by every resource.

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});
export const noContent = { 204: { description: "Done" } };

/** The audit entry and `{target}.changed` outbox event for one change. */
export function changeOf(
  member: Member,
  target: "component" | "component_group" | "monitor",
  action: ChangeAction,
  ids: string[],
  data?: unknown,
): Change {
  return {
    workspaceId: member.workspaceId,
    actorUserId: member.userId,
    action: `${target}.${action}`,
    targetType: target,
    targetId: ids.length === 1 ? (ids[0] ?? null) : null,
    data,
    event: {
      id: eventId.parse(v7()),
      type: `${target}.changed`,
      occurredAt: new Date().toISOString(),
      workspaceId: member.workspaceId,
      data: { action, ids },
    },
  };
}

/** The audit entry and outbox event for a change whose event has its own type and data. */
export function eventChange(
  member: Member,
  target: { type: string; id: string },
  event: { type: string; data: unknown },
): Change {
  return {
    workspaceId: member.workspaceId,
    actorUserId: member.userId,
    action: event.type,
    targetType: target.type,
    targetId: target.id,
    event: {
      id: eventId.parse(v7()),
      type: event.type,
      occurredAt: new Date().toISOString(),
      workspaceId: member.workspaceId,
      data: event.data,
    },
  };
}

/**
 * The change, its audit entry and its outbox row in one transaction; then the outbox row goes to
 * the dispatcher. The trigger comes after the commit, so the dispatcher never sees a row that can
 * still roll back. If trigger.dev is unreachable, the request still succeeds and the row stays
 * pending until it is dispatched again.
 */
export async function commit(deps: Deps, change: Change, write: (tx: Db) => Promise<unknown>) {
  const outboxId = await deps.db.transaction(async (tx) => {
    await write(tx);
    return recordChange(tx, change);
  });
  await dispatch(deps, outboxId);
}

/** Hands a committed outbox row to the dispatcher; if trigger.dev is unreachable it stays pending. */
export async function dispatch(deps: Deps, outboxId: OutboxId) {
  try {
    await deps.engine.trigger(
      "outbox.dispatch",
      { outboxId },
      { idempotencyKey: `outbox:${outboxId}` },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("outbox.dispatch was not triggered", { outboxId, reason });
  }
}
