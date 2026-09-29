import { type ComponentId, type MaintenanceId, maintenanceStatuses } from "@galena/contracts";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { component } from "./pages.ts";
import { workspaceRef } from "./workspace.ts";

export const maintenanceStatus = pgEnum("maintenance_status", maintenanceStatuses);

const at = () => timestamp({ withTimezone: true });

export const maintenance = pgTable(
  "maintenance",
  {
    id: uuid().primaryKey().$type<MaintenanceId>(),
    workspaceId: workspaceRef(),
    title: text().notNull(),
    body: text().notNull(),
    status: maintenanceStatus().notNull().default("scheduled"),
    startsAt: at().notNull(),
    endsAt: at().notNull(),
    version: integer().notNull().default(1),
    runId: text(),
    cancelledAt: at(),
    // Soft delete: the audit trail keeps pointing at it.
    deletedAt: at(),
    ...timestamps,
  },
  (t) => [
    index().on(t.workspaceId, t.startsAt),
    // monitors.json lists the windows still to run on every rebuild.
    index("maintenance_unfinished_idx")
      .on(t.startsAt)
      .where(sql`${t.status} <> 'completed' and ${t.deletedAt} is null`),
  ],
);

export const maintenanceComponent = pgTable(
  "maintenance_component",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    maintenanceId: uuid()
      .notNull()
      .$type<MaintenanceId>()
      .references(() => maintenance.id, { onDelete: "cascade" }),
    componentId: uuid()
      .notNull()
      .$type<ComponentId>()
      .references(() => component.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.maintenanceId, t.componentId),
    index().on(t.componentId),
    index().on(t.workspaceId),
  ],
);
