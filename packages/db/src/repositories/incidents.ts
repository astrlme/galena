import type { AffectedComponent, IncidentId, WorkspaceId } from "@galena/contracts";
import type { Incident, IncidentChange, IncidentRepository } from "@galena/core";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
  approvalDeadline: incident.approvalDeadline,
};

// Open: not resolved, deleted or dismissed, as in the partial unique index on dedup keys. The
// visibility is compared as text: the Data API sends parameters as text.
const open = sql`${incident.resolvedAt} is null and ${incident.deletedAt} is null and ${incident.visibility} <> 'dismissed'`;

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

  const updateColumns = {
    id: incidentUpdate.id,
    status: incidentUpdate.status,
    body: incidentUpdate.body,
    createdAt: incidentUpdate.createdAt,
  };

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

    async listForPage(workspaceId, resolvedSince) {
      const rows = await db
        .select(columns)
        .from(incident)
        .where(
          and(
            eq(incident.workspaceId, workspaceId),
            isNull(incident.deletedAt),
            or(isNull(incident.resolvedAt), gte(incident.resolvedAt, resolvedSince)),
          ),
        )
        .orderBy(desc(incident.startedAt), desc(incident.id))
        .limit(MAX_INCIDENTS);
      const ids = rows.map((r) => r.id);
      const [components, updates] = await Promise.all([
        componentsOf(ids),
        ids.length === 0
          ? []
          : db
              .select({ ...updateColumns, incidentId: incidentUpdate.incidentId })
              .from(incidentUpdate)
              .where(inArray(incidentUpdate.incidentId, ids))
              .orderBy(desc(incidentUpdate.createdAt), desc(incidentUpdate.id))
              .limit(MAX_UPDATES),
      ]);
      return rows.map((row) => ({
        ...row,
        components: components.get(row.id) ?? [],
        updates: updates.flatMap(({ incidentId, ...u }) => (incidentId === row.id ? [u] : [])),
      }));
    },

    async findById(workspaceId, id) {
      const [row] = await db.select(columns).from(incident).where(scoped(workspaceId, id)).limit(1);
      if (!row) return undefined;
      const updates = await db
        .select(updateColumns)
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

    async openAffecting(workspaceId, componentId) {
      const rows = await db
        .select(columns)
        .from(incident)
        .innerJoin(incidentComponent, eq(incidentComponent.incidentId, incident.id))
        .where(
          and(
            eq(incident.workspaceId, workspaceId),
            eq(incidentComponent.componentId, componentId),
            open,
          ),
        )
        .orderBy(desc(incident.startedAt), desc(incident.id));
      const components = await componentsOf(rows.map((r) => r.id));
      return rows.map((row): Incident => ({ ...row, components: components.get(row.id) ?? [] }));
    },

    async createOnce(value, first) {
      const [created] = await db
        .insert(incident)
        .values({ ...value, ...first.stage })
        .onConflictDoNothing({ target: [incident.workspaceId, incident.dedupKey], where: open })
        .returning({ id: incident.id });
      if (created) {
        await write(value.workspaceId, value.id, first);
        return { id: created.id, created: true };
      }
      const [existing] = await db
        .select({ id: incident.id })
        .from(incident)
        .where(
          and(
            eq(incident.workspaceId, value.workspaceId),
            eq(incident.dedupKey, value.dedupKey),
            open,
          ),
        )
        .limit(1);
      if (!existing) throw new Error(`No open incident holds ${value.dedupKey} after a conflict.`);
      return { id: existing.id, created: false };
    },

    async decide(workspaceId, id, visibility) {
      const decided = await db
        .update(incident)
        .set({ visibility, approvalDeadline: null })
        .where(and(scoped(workspaceId, id), sql`${incident.visibility}::text = 'draft'`))
        .returning({ id: incident.id });
      return decided.length > 0;
    },

    async setApprovalToken(workspaceId, id, tokenId) {
      await db.update(incident).set({ approvalTokenId: tokenId }).where(scoped(workspaceId, id));
    },
  };
}
