import { z } from "zod";
import {
  componentStatuses,
  incidentImpacts,
  incidentStatuses,
  maintenanceStatuses,
} from "./enums.ts";
import { componentId, eventId } from "./ids.ts";

export const noticeKinds = [
  "incident_created",
  "incident_updated",
  "incident_resolved",
  "maintenance_scheduled",
  "maintenance_started",
  "maintenance_completed",
  "maintenance_cancelled",
] as const;
export type NoticeKind = (typeof noticeKinds)[number];

/**
 * What every channel renders for one event: built once by the fan-out and handed to each send,
 * so a send reads nothing but its own target. Public text only.
 */
export const notice = z.object({
  kind: z.enum(noticeKinds),
  eventId,
  page: z.object({ name: z.string(), url: z.url() }),
  title: z.string(),
  status: z.union([z.enum(incidentStatuses), z.enum(maintenanceStatuses)]),
  /** Incidents only. */
  impact: z.enum(incidentImpacts).nullable(),
  components: z.array(
    z.object({
      id: componentId,
      name: z.string(),
      /** What the incident says about it; null for maintenance. */
      status: z.enum(componentStatuses).nullable(),
    }),
  ),
  /** The latest update, or the window's message. Plain text with the page's small Markdown. */
  body: z.string(),
  /** When the incident started or the window starts. */
  startsAt: z.iso.datetime(),
  /** When the incident resolved or the window ends. */
  endsAt: z.iso.datetime().nullable(),
  /** When this change happened. */
  occurredAt: z.iso.datetime(),
  /** The incident's page, or the status page for maintenance. */
  url: z.url(),
});
export type Notice = z.infer<typeof notice>;
