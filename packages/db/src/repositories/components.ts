import type { Component, ComponentRepository } from "@galena/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { component } from "../schema/index.ts";

// Known limit: one page lists at most this many components; paginate if a workspace ever needs more.
const MAX_COMPONENTS = 500;

const columns = {
  id: component.id,
  workspaceId: component.workspaceId,
  groupId: component.groupId,
  name: component.name,
  description: component.description,
  position: component.position,
  status: component.status,
  manualStatus: component.manualStatus,
};

export function componentRepository(db: Db): ComponentRepository {
  return {
    listByWorkspace: (workspaceId) =>
      db
        .select(columns)
        .from(component)
        .where(eq(component.workspaceId, workspaceId))
        .orderBy(asc(component.position), asc(component.id))
        .limit(MAX_COMPONENTS),

    async findById(workspaceId, id) {
      const [row] = await db
        .select(columns)
        .from(component)
        .where(and(eq(component.workspaceId, workspaceId), eq(component.id, id)))
        .limit(1);
      return row;
    },

    async save(value: Component) {
      const { id, workspaceId, ...fields } = value;
      await db
        .insert(component)
        .values(value)
        .onConflictDoUpdate({
          target: component.id,
          set: fields,
          // An id from another workspace must never be overwritten.
          setWhere: eq(component.workspaceId, workspaceId),
        });
    },

    async delete(workspaceId, id) {
      await db
        .delete(component)
        .where(and(eq(component.workspaceId, workspaceId), eq(component.id, id)));
    },
  };
}
