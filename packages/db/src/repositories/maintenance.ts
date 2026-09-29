import type { ComponentId, MaintenanceId } from "@galena/contracts";
import type { Maintenance, MaintenanceRepository } from "@galena/core";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { maintenance, maintenanceComponent } from "../schema/index.ts";

// Known limit: the dashboard lists this many windows, newest first.
const MAX_ROWS = 100;

const columns = {
  id: maintenance.id,
  workspaceId: maintenance.workspaceId,
  title: maintenance.title,
  body: maintenance.body,
  status: maintenance.status,
  startsAt: maintenance.startsAt,
  endsAt: maintenance.endsAt,
  version: maintenance.version,
  runId: maintenance.runId,
  cancelledAt: maintenance.cancelledAt,
};
type Row = Omit<Maintenance, "componentIds">;

export function maintenanceRepository(db: Db): MaintenanceRepository {
  const scoped = (workspaceId: Maintenance["workspaceId"], id: MaintenanceId) =>
    and(
      eq(maintenance.workspaceId, workspaceId),
      eq(maintenance.id, id),
      isNull(maintenance.deletedAt),
    );

  async function withComponents(rows: Row[]): Promise<Maintenance[]> {
    if (rows.length === 0) return [];
    const links = await db
      .select({
        maintenanceId: maintenanceComponent.maintenanceId,
        componentId: maintenanceComponent.componentId,
      })
      .from(maintenanceComponent)
      .where(
        inArray(
          maintenanceComponent.maintenanceId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(maintenanceComponent.id));
    const byWindow = new Map<MaintenanceId, ComponentId[]>();
    for (const { maintenanceId, componentId } of links) {
      byWindow.set(maintenanceId, [...(byWindow.get(maintenanceId) ?? []), componentId]);
    }
    return rows.map((row) => ({ ...row, componentIds: byWindow.get(row.id) ?? [] }));
  }

  return {
    async list(workspaceId) {
      const rows = await db
        .select(columns)
        .from(maintenance)
        .where(and(eq(maintenance.workspaceId, workspaceId), isNull(maintenance.deletedAt)))
        .orderBy(desc(maintenance.startsAt), desc(maintenance.id))
        .limit(MAX_ROWS);
      return withComponents(rows);
    },

    async findById(workspaceId, id) {
      const rows = await db
        .select(columns)
        .from(maintenance)
        .where(scoped(workspaceId, id))
        .limit(1);
      const [found] = await withComponents(rows);
      return found;
    },

    async save(window, expectedVersion) {
      const { componentIds, ...row } = window;
      const { id, workspaceId } = row;
      if (expectedVersion === null) {
        await db.insert(maintenance).values(row);
      } else {
        // Status is the lifecycle run's to move; an edit changes only what people wrote.
        const { title, body, startsAt, endsAt, version } = window;
        const updated = await db
          .update(maintenance)
          .set({ title, body, startsAt, endsAt, version })
          .where(
            and(
              scoped(workspaceId, id),
              eq(maintenance.version, expectedVersion),
              sql`${maintenance.status}::text <> 'completed'`,
            ),
          )
          .returning({ id: maintenance.id });
        if (updated.length === 0) return false;
        await db.delete(maintenanceComponent).where(eq(maintenanceComponent.maintenanceId, id));
      }
      if (componentIds.length > 0) {
        await db.insert(maintenanceComponent).values(
          componentIds.map((componentId) => ({
            id: v7(),
            workspaceId,
            maintenanceId: id,
            componentId,
          })),
        );
      }
      return true;
    },

    async transition(workspaceId, id, from, to) {
      const moved = await db
        .update(maintenance)
        .set({ status: to.status, ...(to.cancelledAt ? { cancelledAt: to.cancelledAt } : {}) })
        .where(
          and(
            scoped(workspaceId, id),
            eq(maintenance.version, from.version),
            // Compared as text: the Data API sends parameters as text.
            sql`${maintenance.status}::text = ${from.status}`,
          ),
        )
        .returning({ id: maintenance.id });
      return moved.length === 1;
    },

    async setRunId(id, version, runId) {
      await db
        .update(maintenance)
        .set({ runId })
        .where(and(eq(maintenance.id, id), eq(maintenance.version, version)));
    },

    async listUnfinished() {
      const rows = await db
        .select(columns)
        .from(maintenance)
        .where(and(isNull(maintenance.deletedAt), sql`${maintenance.status}::text <> 'completed'`))
        .orderBy(asc(maintenance.startsAt), asc(maintenance.id))
        .limit(MAX_ROWS * 5);
      return withComponents(rows);
    },
  };
}
