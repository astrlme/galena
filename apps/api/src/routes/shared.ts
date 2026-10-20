import { type ChangeAction, eventId, type OutboxId, outboxId } from "@galena/contracts";
import { type Change, type Db, recordChange } from "@galena/db";
import type { z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type Deps, fail, type Member } from "../http.ts";

// Route helpers shared by every resource.

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});
export const noContent = { 204: { description: "Done" } };

/**
 * How many of each a workspace may have. Monitors cost probe time and queue messages every minute
 * in every region (50 is what the default telemetry table takes), and the rest add sends or
 * lookups, so a mistake or a stolen key can't multiply the bill. Known limit: fixed here; make
 * them deployment settings, with the table's capacity, if someone needs more.
 */
export const CAPS = { monitors: 50, apiKeys: 50, endpoints: 50, integrations: 50 } as const;

/** Refuses one more of `what` once the workspace has `cap` of them. */
export function assertUnderCap(what: string, count: number, cap: number) {
  if (count < cap) return;
  fail({
    status: 409,
    code: "limit_reached",
    title: `At most ${cap} ${what}`,
    detail: `This workspace has ${count} ${what}, the most it can have. Delete one to add another.`,
  });
}

/** The audit entry and `{target}.changed` outbox event for one change. */
export function changeOf(
  member: Member,
  target:
    | "component"
    | "component_group"
    | "monitor"
    | "webhook_endpoint"
    | "subscriber"
    | "integration"
    | "api_key",
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
 * the dispatcher. Before the transaction, a dispatch delayed by a minute is armed for the row's
 * id, so the event still goes out if this process dies between the commit and the trigger after
 * it; if the transaction rolls back, that run finds no row and stops. If the job queue is
 * unreachable, the request still succeeds and the outbox sweep picks the pending row up.
 */
export async function commit(deps: Deps, change: Change, write: (tx: Db) => Promise<unknown>) {
  const id = outboxId.parse(v7());
  const backstop = new Date(Date.now() + 60_000);
  await trigger(deps, id, { idempotencyKey: `outbox:${id}:backstop`, at: backstop });
  await deps.db.transaction(async (tx) => {
    await write(tx);
    await recordChange(tx, change, id);
  });
  await dispatch(deps, id);
}

/** Hands a committed outbox row to the dispatcher. */
export async function dispatch(deps: Deps, id: OutboxId) {
  await trigger(deps, id, { idempotencyKey: `outbox:${id}` });
}

async function trigger(deps: Deps, id: OutboxId, options: { idempotencyKey: string; at?: Date }) {
  try {
    await deps.engine.trigger("outbox.dispatch", { outboxId: id }, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("outbox.dispatch was not triggered", { outboxId: id, reason });
  }
}
