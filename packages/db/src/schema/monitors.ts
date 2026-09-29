import {
  type ComponentId,
  type DetectionSettings,
  downStatuses,
  type HttpCheck,
  type MonitorId,
  monitorStates,
  monitorTypes,
  publishPolicies,
} from "@galena/contracts";
import {
  boolean,
  index,
  integer,
  jsonb,
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

export const monitorType = pgEnum("monitor_type", monitorTypes);
export const publishPolicy = pgEnum("publish_policy", publishPolicies);
export const downStatus = pgEnum("down_status", downStatuses);
export const monitorState = pgEnum("monitor_state", monitorStates);

export const monitor = pgTable(
  "monitor",
  {
    id: uuid().primaryKey().$type<MonitorId>(),
    workspaceId: workspaceRef(),
    componentId: uuid()
      .$type<ComponentId>()
      .references(() => component.id, { onDelete: "set null" }),
    name: text().notNull(),
    type: monitorType().notNull(),
    // Per-type settings as validated by contracts; other check types bring their own shape.
    http: jsonb().$type<HttpCheck>().notNull(),
    publishPolicy: publishPolicy().notNull().default("approve"),
    downStatus: downStatus().notNull().default("major_outage"),
    detection: jsonb().$type<DetectionSettings>().notNull(),
    enabled: boolean().notNull().default(true),
    /** The last confirmed state detection reported, and its `transitionSeq`. */
    state: monitorState().notNull().default("unknown"),
    stateSeq: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId), index().on(t.componentId)],
);

/** Every confirmed transition, once each: the history the uptime rollup reads. */
export const monitorStateChange = pgTable(
  "monitor_state_change",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    monitorId: uuid()
      .notNull()
      .$type<MonitorId>()
      .references(() => monitor.id, { onDelete: "cascade" }),
    fromState: monitorState().notNull(),
    toState: monitorState().notNull(),
    seq: integer().notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.monitorId, t.seq), index().on(t.workspaceId, t.at)],
);
