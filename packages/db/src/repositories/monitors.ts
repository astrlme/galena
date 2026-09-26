import type { MonitorId, WorkspaceId } from "@galena/contracts";
import type { MonitorRepository } from "@galena/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { monitor } from "../schema/index.ts";

// Known limit: every monitor is checked every minute from each region, so a workspace with more
// than this outgrows one probe invocation long before the list needs paginating.
const MAX_ROWS = 500;

const columns = {
  id: monitor.id,
  workspaceId: monitor.workspaceId,
  componentId: monitor.componentId,
  name: monitor.name,
  type: monitor.type,
  http: monitor.http,
  publishPolicy: monitor.publishPolicy,
  downStatus: monitor.downStatus,
  detection: monitor.detection,
  enabled: monitor.enabled,
};

export function monitorRepository(db: Db): MonitorRepository {
  const scoped = (workspaceId: WorkspaceId, id: MonitorId) =>
    and(eq(monitor.workspaceId, workspaceId), eq(monitor.id, id));
  return {
    listByWorkspace: (workspaceId) =>
      db
        .select(columns)
        .from(monitor)
        .where(eq(monitor.workspaceId, workspaceId))
        .orderBy(asc(monitor.id))
        .limit(MAX_ROWS),

    async findById(workspaceId, id) {
      const [row] = await db.select(columns).from(monitor).where(scoped(workspaceId, id)).limit(1);
      return row;
    },

    async save(value) {
      const { id, workspaceId, ...fields } = value;
      await db
        .insert(monitor)
        .values(value)
        .onConflictDoUpdate({
          target: monitor.id,
          set: fields,
          // An id from another workspace must never be overwritten.
          setWhere: eq(monitor.workspaceId, workspaceId),
        });
    },

    async delete(workspaceId, id) {
      await db.delete(monitor).where(scoped(workspaceId, id));
    },
  };
}
