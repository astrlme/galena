import { z } from "zod";
import {
  componentStatuses,
  incidentImpacts,
  incidentStatuses,
  maintenanceStatuses,
  pageIndicators,
} from "./enums.ts";
import {
  componentGroupId,
  componentId,
  incidentId,
  incidentUpdateId,
  maintenanceId,
} from "./ids.ts";
import { affectedComponent } from "./incidents.ts";

// `snapshot.json`: the page's read model. The status page, the feeds, the badge and every other
// published file derive from it. Public data only: nothing a draft, dismissed or internal
// incident says ever reaches it.

const iso = z.iso.datetime();

/** One day of a component's signal strip, in UTC. */
export const snapshotDay = z.object({
  date: z.iso.date(),
  /** The worst state that lasted at least a minute; null before the component existed. */
  worst: z.enum(componentStatuses).nullable(),
  /** Minutes in partial or major outage. Maintenance never counts as downtime. */
  downMinutes: z.int().min(0).max(1440),
  /** Whole minutes in each state that day; states it never reached are left out. */
  minutes: z.partialRecord(z.enum(componentStatuses), z.int().min(1).max(1440)).optional(),
});
export type SnapshotDay = z.infer<typeof snapshotDay>;

export const snapshotComponent = z.object({
  id: componentId,
  groupId: componentGroupId.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(componentStatuses),
  /** Oldest first, up to 90 days ending today. */
  days: z.array(snapshotDay).max(90),
  /** Percent of the observed minutes outside an outage, two decimals; null with no data. */
  uptime: z.number().min(0).max(100).nullable(),
});
export type SnapshotComponent = z.infer<typeof snapshotComponent>;

export const snapshotIncident = z.object({
  id: incidentId,
  title: z.string(),
  status: z.enum(incidentStatuses),
  impact: z.enum(incidentImpacts),
  startedAt: iso,
  resolvedAt: iso.nullable(),
  updatedAt: iso,
  components: z.array(affectedComponent),
  /** Newest first. */
  updates: z.array(
    z.object({
      id: incidentUpdateId,
      status: z.enum(incidentStatuses),
      body: z.string(),
      createdAt: iso,
    }),
  ),
});
export type SnapshotIncident = z.infer<typeof snapshotIncident>;

export const snapshotMaintenance = z.object({
  id: maintenanceId,
  title: z.string(),
  body: z.string(),
  status: z.enum(maintenanceStatuses),
  startsAt: iso,
  endsAt: iso,
  componentIds: z.array(componentId),
});
export type SnapshotMaintenance = z.infer<typeof snapshotMaintenance>;

export const snapshot = z.object({
  version: z.literal(1),
  /** Allocated with the change being published; a newer page never loses to an older one. */
  snapshotVersion: z.int().min(1),
  publishedAt: iso,
  page: z.object({ slug: z.string(), name: z.string(), url: z.url() }),
  indicator: z.enum(pageIndicators),
  /** In page order; components with no group come first. */
  groups: z.array(
    z.object({ id: componentGroupId, name: z.string(), componentIds: z.array(componentId) }),
  ),
  components: z.array(snapshotComponent),
  incidents: z.object({
    /** Published and not yet resolved, newest first. */
    active: z.array(snapshotIncident),
    /** Resolved in the last 14 days, newest first. */
    recent: z.array(snapshotIncident),
  }),
  maintenance: z.object({
    active: z.array(snapshotMaintenance),
    /** Not started yet, soonest first. Cancelled windows never appear. */
    upcoming: z.array(snapshotMaintenance),
  }),
});
export type Snapshot = z.infer<typeof snapshot>;
