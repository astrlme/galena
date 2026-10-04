import {
  type ComponentId,
  type IncidentComponentStatus,
  type IncidentId,
  type IncidentUpdateId,
  incidentImpacts,
  incidentSources,
  incidentStatuses,
  incidentVisibilities,
  timelineEventKinds,
} from "@galena/contracts";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { timestamps } from "./columns.ts";
import { component, componentStatus } from "./pages.ts";
import { workspaceRef } from "./workspace.ts";

export const incidentStatus = pgEnum("incident_status", incidentStatuses);
export const incidentImpact = pgEnum("incident_impact", incidentImpacts);
export const incidentVisibility = pgEnum("incident_visibility", incidentVisibilities);
export const incidentSource = pgEnum("incident_source", incidentSources);
export const timelineEventKind = pgEnum("timeline_event_kind", timelineEventKinds);

const at = () => timestamp({ withTimezone: true });

export const incident = pgTable(
  "incident",
  {
    id: uuid().primaryKey().$type<IncidentId>(),
    workspaceId: workspaceRef(),
    title: text().notNull(),
    status: incidentStatus().notNull(),
    impact: incidentImpact().notNull(),
    visibility: incidentVisibility().notNull().default("published"),
    source: incidentSource().notNull().default("manual"),
    startedAt: at().notNull(),
    resolvedAt: at(),
    // Soft delete: the audit trail keeps pointing at it.
    deletedAt: at(),
    // Set on incidents a monitor opened (`mon:{monitorId}`): one open incident per key, so a
    // retried transition finds the draft it already wrote.
    dedupKey: text(),
    // A draft waiting for a person: when it publishes unless someone answers, and the waitpoint
    // token their answer completes.
    approvalDeadline: at(),
    approvalTokenId: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.workspaceId, t.startedAt),
    // Open means not resolved, deleted or dismissed: a dismissed draft lets the monitor draft again.
    uniqueIndex("incident_open_dedup_idx")
      .on(t.workspaceId, t.dedupKey)
      .where(
        sql`${t.resolvedAt} is null and ${t.deletedAt} is null and ${t.visibility} <> 'dismissed'`,
      ),
    // Open incidents first: the dashboard and the publisher ask for them on every read.
    index("incident_open_idx")
      .on(t.workspaceId)
      .where(sql`${t.resolvedAt} is null and ${t.deletedAt} is null`),
  ],
);

const incidentRef = () =>
  uuid()
    .notNull()
    .$type<IncidentId>()
    .references(() => incident.id, { onDelete: "cascade" });

/** One public message on an incident. Append-only: never updated once written. */
export const incidentUpdate = pgTable(
  "incident_update",
  {
    id: uuid().primaryKey().$type<IncidentUpdateId>(),
    workspaceId: workspaceRef(),
    incidentId: incidentRef(),
    status: incidentStatus().notNull(),
    body: text().notNull(),
    createdByUserId: text().references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index().on(t.incidentId, t.createdAt),
    index().on(t.workspaceId),
    index().on(t.createdByUserId),
  ],
);

/** The components an incident affects, and the status it gives each while it is open. */
export const incidentComponent = pgTable(
  "incident_component",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    incidentId: incidentRef(),
    componentId: uuid()
      .notNull()
      .$type<ComponentId>()
      .references(() => component.id, { onDelete: "cascade" }),
    status: componentStatus().notNull().$type<IncidentComponentStatus>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.incidentId, t.componentId),
    index().on(t.componentId),
    index().on(t.workspaceId),
  ],
);

/** What happened to an incident besides its public updates: status changes, notes, signals. */
export const timelineEvent = pgTable(
  "timeline_event",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    incidentId: incidentRef(),
    kind: timelineEventKind().notNull(),
    data: jsonb().notNull(),
    actorUserId: text().references(() => user.id, { onDelete: "set null" }),
    occurredAt: at().notNull(),
    ...timestamps,
  },
  (t) => [
    index().on(t.incidentId, t.occurredAt),
    index().on(t.workspaceId),
    index().on(t.actorUserId),
  ],
);
