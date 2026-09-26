import {
  type ComponentId,
  type DetectionSettings,
  downStatuses,
  type HttpCheck,
  type MonitorId,
  monitorTypes,
  publishPolicies,
} from "@galena/contracts";
import { boolean, index, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { component } from "./pages.ts";
import { workspaceRef } from "./workspace.ts";

export const monitorType = pgEnum("monitor_type", monitorTypes);
export const publishPolicy = pgEnum("publish_policy", publishPolicies);
export const downStatus = pgEnum("down_status", downStatuses);

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
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId), index().on(t.componentId)],
);
