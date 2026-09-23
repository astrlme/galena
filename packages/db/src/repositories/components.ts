import type { ComponentGroupId, ComponentId, WorkspaceId } from "@galena/contracts";
import type { ComponentGroupRepository, ComponentRepository } from "@galena/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { component, componentGroup } from "../schema/index.ts";

// Known limit: one page lists at most this many components; paginate if a workspace ever needs more.
const MAX_ROWS = 500;

const componentColumns = {
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
  const scoped = (workspaceId: WorkspaceId, id: ComponentId) =>
    and(eq(component.workspaceId, workspaceId), eq(component.id, id));
  return {
    listByWorkspace: (workspaceId) =>
      db
        .select(componentColumns)
        .from(component)
        .where(eq(component.workspaceId, workspaceId))
        .orderBy(asc(component.position), asc(component.id))
        .limit(MAX_ROWS),

    async findById(workspaceId, id) {
      const [row] = await db
        .select(componentColumns)
        .from(component)
        .where(scoped(workspaceId, id))
        .limit(1);
      return row;
    },

    async save(value) {
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
      await db.delete(component).where(scoped(workspaceId, id));
    },

    async setPositions(workspaceId, positions) {
      // Known limit: one UPDATE per row; fine for tens of rows, batch it if lists grow to hundreds.
      for (const [id, position] of positions) {
        await db.update(component).set({ position }).where(scoped(workspaceId, id));
      }
    },
  };
}

const groupColumns = {
  id: componentGroup.id,
  workspaceId: componentGroup.workspaceId,
  name: componentGroup.name,
  position: componentGroup.position,
};

export function componentGroupRepository(db: Db): ComponentGroupRepository {
  const scoped = (workspaceId: WorkspaceId, id: ComponentGroupId) =>
    and(eq(componentGroup.workspaceId, workspaceId), eq(componentGroup.id, id));
  return {
    listByWorkspace: (workspaceId) =>
      db
        .select(groupColumns)
        .from(componentGroup)
        .where(eq(componentGroup.workspaceId, workspaceId))
        .orderBy(asc(componentGroup.position), asc(componentGroup.id))
        .limit(MAX_ROWS),

    async findById(workspaceId, id) {
      const [row] = await db
        .select(groupColumns)
        .from(componentGroup)
        .where(scoped(workspaceId, id))
        .limit(1);
      return row;
    },

    async save(value) {
      const { id, workspaceId, ...fields } = value;
      await db
        .insert(componentGroup)
        .values(value)
        .onConflictDoUpdate({
          target: componentGroup.id,
          set: fields,
          setWhere: eq(componentGroup.workspaceId, workspaceId),
        });
    },

    async delete(workspaceId, id) {
      await db.delete(componentGroup).where(scoped(workspaceId, id));
    },

    async setPositions(workspaceId, positions) {
      for (const [id, position] of positions) {
        await db.update(componentGroup).set({ position }).where(scoped(workspaceId, id));
      }
    },
  };
}
