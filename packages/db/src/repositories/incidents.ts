import type { AffectedComponent, IncidentId, WorkspaceId } from "@galena/contracts";
import type { Incident, IncidentChange, IncidentRepository } from "@galena/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { v7 } from "uuid";
import type { Db } from "../client.ts";
import { incident, incidentComponent, incidentUpdate, timelineEvent } from "../schema/index.ts";

// Known limit: lists stop here; the dashboard shows open incidents and the latest resolved ones.
const MAX_INCIDENTS = 100;
const MAX_UPDATES = 500;

const columns = {
  id: incident.id,
  workspaceId: incident.workspaceId,
  title: incident.title,
  status: incident.status,
  impact: incident.impact,
  visibility: incident.visibility,
  source: incident.source,
  startedAt: incident.startedAt,
  resolvedAt: incident.resolvedAt,
  updatedAt: incident.updatedAt,
};

export function incidentRepository(db: Db): IncidentRepository {
  const scoped = (workspaceId: WorkspaceId, id: IncidentId) =>
    and(eq(incident.workspaceId, workspaceId), eq(incident.id, id), isNull(incident.deletedAt));

  /** Components per incident, in one query for the whole list. */
  async function componentsOf(ids: IncidentId[]) {
    const byIncident = new Map<IncidentId, AffectedComponent[]>();
    if (ids.length === 0) return byIncident;
    const rows = await db
      .select({
        incidentId: incidentComponent.incidentId,
        componentId: incidentComponent.componentId,
        status: incidentComponent.status,
      })
      .from(incidentComponent)
      .where(inArray(incidentComponent.incidentId, ids))
      .orderBy(asc(incidentComponent.id));
    for (const { incidentId, ...affected } of rows) {
      byIncident.set(incidentId, [...(byIncident.get(incidentId) ?? []), affected]);
    }
    return byIncident;
  }

  /** The update and whatever it changes, beside the incident row itself. */
  async function write(workspaceId: WorkspaceId, incidentId: IncidentId, change: IncidentChange) {
    await db.insert(incidentUpdate).values({ ...change.update, workspaceId, incidentId });
    if (change.components) {
      await db.delete(incidentComponent).where(eq(incidentComponent.incidentId, incidentId));
      if (change.components.length > 0) {
        await db
          .insert(incidentComponent)
          .values(change.components.map((c) => ({ id: v7(), workspaceId, incidentId, ...c })));
      }
    }
    if (change.statusChange) {
      await db.insert(timelineEvent).values({
        id: v7(),
        workspaceId,
        incidentId,
        kind: "status_changed",
        data: change.statusChange,
        actorUserId: change.update.createdByUserId,
        occurredAt: change.update.createdAt,
      });
    }
  }

  return {
    async list(workspaceId, { open }) {
      const rows = await db
        .select(columns)
        .from(incident)
        .where(
          and(
            eq(incident.workspaceId, workspaceId),
            isNull(incident.deletedAt),
            open ? isNull(incident.resolvedAt) : isNotNull(incident.resolvedAt),
          ),
        )
        .orderBy(desc(incident.startedAt), desc(incident.id))
        .limit(MAX_INCIDENTS);
      const components = await componentsOf(rows.map((r) => r.id));
      return rows.map((row): Incident => ({ ...row, components: components.get(row.id) ?? [] }));
    },

    async findById(workspaceId, id) {
      const [row] = await db.select(columns).from(incident).where(scoped(workspaceId, id)).limit(1);
      if (!row) return undefined;
      const updates = await db
        .select({
          id: incidentUpdate.id,
          status: incidentUpdate.status,
          body: incidentUpdate.body,
          createdAt: incidentUpdate.createdAt,
        })
        .from(incidentUpdate)
        .where(eq(incidentUpdate.incidentId, id))
        .orderBy(desc(incidentUpdate.createdAt), desc(incidentUpdate.id))
        .limit(MAX_UPDATES);
      const components = await componentsOf([id]);
      return { ...row, components: components.get(id) ?? [], updates };
    },

    async create(value, first) {
      await db.insert(incident).values({ ...value, ...first.stage });
      await write(value.workspaceId, value.id, first);
    },

    async append(workspaceId, id, expected, change) {
      // Every update touches the row, so updated_at is the time of the last update. The status
      // is compared as text: the Data API sends parameters as text, and enum = text has no operator.
      const moved = await db
        .update(incident)
        .set({ ...change.stage, ...(change.impact ? { impact: change.impact } : {}) })
        .where(and(scoped(workspaceId, id), sql`${incident.status}::text = ${expected}`))
        .returning({ id: incident.id });
      if (moved.length === 0) return false;
      await write(workspaceId, id, change);
      return true;
    },
  };
}
