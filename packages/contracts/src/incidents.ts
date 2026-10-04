import { z } from "zod";
import {
  componentStatuses,
  incidentImpacts,
  incidentSources,
  incidentStatuses,
  incidentVisibilities,
} from "./enums.ts";
import { componentId, incidentId, incidentUpdateId } from "./ids.ts";

/** What an incident may say about a component; maintenance windows own `under_maintenance`. */
export const incidentComponentStatus = z.enum(componentStatuses).exclude(["under_maintenance"]);
export type IncidentComponentStatus = z.infer<typeof incidentComponentStatus>;

export const affectedComponent = z.object({ componentId, status: incidentComponentStatus });
export type AffectedComponent = z.infer<typeof affectedComponent>;

const affectedComponents = z
  .array(affectedComponent)
  .max(100)
  .refine((list) => new Set(list.map((c) => c.componentId)).size === list.length, {
    message: "List each component once.",
  });

/** Markdown. Core checks it again before it is stored (no HTML, no script links). */
const updateBody = z.string().trim().min(1, "Write what is happening.").max(5_000);

export const incidentCreate = z.object({
  title: z.string().trim().min(1, "Give the incident a title.").max(200),
  impact: z.enum(incidentImpacts),
  status: z.enum(incidentStatuses).default("investigating"),
  body: updateBody,
  components: affectedComponents.default([]),
});
export type IncidentCreate = z.infer<typeof incidentCreate>;

/** One more update. Impact and components change only when they are sent. */
export const incidentUpdateCreate = z.object({
  status: z.enum(incidentStatuses),
  body: updateBody,
  impact: z.enum(incidentImpacts).optional(),
  components: affectedComponents.optional(),
});
export type IncidentUpdateCreate = z.infer<typeof incidentUpdateCreate>;

export const incidentUpdateView = z.object({
  id: incidentUpdateId,
  status: z.enum(incidentStatuses),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

export const incidentSummary = z.object({
  id: incidentId,
  title: z.string(),
  status: z.enum(incidentStatuses),
  impact: z.enum(incidentImpacts),
  visibility: z.enum(incidentVisibilities),
  source: z.enum(incidentSources),
  startedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  /** When the last update was posted. */
  updatedAt: z.iso.datetime(),
  components: z.array(affectedComponent),
  /** A draft a monitor opened publishes at this time if the monitor is still down. */
  approvalDeadline: z.iso.datetime().nullable(),
});
export type IncidentSummary = z.infer<typeof incidentSummary>;

/** An incident with its updates, newest first. */
export const incidentView = incidentSummary.extend({ updates: z.array(incidentUpdateView) });
export type IncidentView = z.infer<typeof incidentView>;

export const incidentEventTypes = [
  "incident.created",
  "incident.updated",
  "incident.resolved",
] as const;
export type IncidentEventType = (typeof incidentEventTypes)[number];

/** The data of every `incident.*` event: enough for the publisher to know what to rebuild. */
export const incidentEventData = z.object({
  incidentId,
  /** The update this event announces, so a notice sent later still carries its own words. */
  updateId: incidentUpdateId.optional(),
  status: z.enum(incidentStatuses),
  impact: z.enum(incidentImpacts),
  visibility: z.enum(incidentVisibilities),
});
