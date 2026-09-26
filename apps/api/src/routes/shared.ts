import { type ChangeAction, eventId } from "@galena/contracts";
import type { Change } from "@galena/db";
import type { z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import type { Member } from "../http.ts";

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
