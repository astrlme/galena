import {
  type ComponentGroupId,
  type ComponentId,
  type ComponentStatus,
  componentStatuses,
  type PageId,
  pageVisibilities,
} from "@galena/contracts";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { workspaceRef } from "./workspace.ts";

export const componentStatus = pgEnum("component_status", componentStatuses);
export const pageVisibility = pgEnum("page_visibility", pageVisibilities);

/**
 * Numbers publishes. A value is only ever taken after the changes it covers have committed, so
 * a publish that read the database after taking version N shows every change numbered below N.
 */
export const snapshotVersion = pgSequence("snapshot_version");

export const page = pgTable(
  "page",
  {
    id: uuid().primaryKey().$type<PageId>(),
    workspaceId: workspaceRef(),
    slug: text().notNull(),
    name: text().notNull(),
    visibility: pageVisibility().notNull().default("public"),
    /** The newest snapshot version whose data files are out. */
    publishedVersion: bigint({ mode: "number" }).notNull().default(0),
    /** The newest snapshot version whose HTML is out. */
    htmlVersion: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.slug)],
);

export const componentGroup = pgTable(
  "component_group",
  {
    id: uuid().primaryKey().$type<ComponentGroupId>(),
    workspaceId: workspaceRef(),
    name: text().notNull(),
    position: integer().notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId, t.position)],
);

export const component = pgTable(
  "component",
  {
    id: uuid().primaryKey().$type<ComponentId>(),
    workspaceId: workspaceRef(),
    groupId: uuid()
      .$type<ComponentGroupId>()
      .references(() => componentGroup.id, { onDelete: "set null" }),
    name: text().notNull(),
    description: text(),
    position: integer().notNull(),
    status: componentStatus().notNull().default("operational"),
    manualStatus: componentStatus(),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId, t.position), index().on(t.groupId)],
);

/** Which components a page shows, in which order. Several pages can share a component. */
export const pageComponent = pgTable(
  "page_component",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    pageId: uuid()
      .notNull()
      .$type<PageId>()
      .references(() => page.id, { onDelete: "cascade" }),
    componentId: uuid()
      .notNull()
      .$type<ComponentId>()
      .references(() => component.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.pageId, t.componentId),
    index().on(t.componentId),
    index().on(t.workspaceId),
  ],
);

/** Minutes one component spent in each status on one UTC day, from the uptime rollup. */
export const uptimeDaily = pgTable(
  "uptime_daily",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    componentId: uuid()
      .notNull()
      .$type<ComponentId>()
      .references(() => component.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    minutes: jsonb().$type<Partial<Record<ComponentStatus, number>>>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.componentId, t.day), index().on(t.workspaceId, t.day)],
);
