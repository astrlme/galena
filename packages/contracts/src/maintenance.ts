import { z } from "zod";
import { maintenanceStatuses } from "./enums.ts";
import { componentId, maintenanceId } from "./ids.ts";

/** Schedule a window, or replace one that hasn't completed (PUT sends every field). */
export const maintenanceInput = z
  .object({
    title: z.string().trim().min(1, "Give the window a title.").max(200),
    body: z.string().trim().min(1, "Say what will happen and what people may notice.").max(5_000),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    componentIds: z
      .array(componentId)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, { message: "List each component once." }),
  })
  .refine((m) => Date.parse(m.endsAt) > Date.parse(m.startsAt), {
    message: "The window must end after it starts.",
    path: ["endsAt"],
  });
export type MaintenanceInput = z.infer<typeof maintenanceInput>;

export const maintenanceView = z.object({
  id: maintenanceId,
  title: z.string(),
  body: z.string(),
  status: z.enum(maintenanceStatuses),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** Set when it was cancelled before it started. */
  cancelledAt: z.iso.datetime().nullable(),
  componentIds: z.array(componentId),
});
export type MaintenanceView = z.infer<typeof maintenanceView>;

export const maintenanceEventTypes = [
  "maintenance.scheduled",
  "maintenance.started",
  "maintenance.completed",
  "maintenance.cancelled",
] as const;
export type MaintenanceEventType = (typeof maintenanceEventTypes)[number];

/**
 * The data of every `maintenance.*` event. `version` counts edits: the lifecycle run for an
 * older version finds it superseded and stops.
 */
export const maintenanceEventData = z.object({
  maintenanceId,
  version: z.int().min(1),
  status: z.enum(maintenanceStatuses),
});
export type MaintenanceEventData = z.infer<typeof maintenanceEventData>;
