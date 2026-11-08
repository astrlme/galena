import { z } from "zod";
import {
  deliveryStatuses,
  endpointKinds,
  incidentStatuses,
  monitorStates,
  monitorTypes,
  signalStatuses,
} from "./enums.ts";
import { eventId, integrationId, monitorId, webhookEndpointId } from "./ids.ts";
import { recentCheck } from "./monitor-charts.ts";
import { awsRegion } from "./monitors.ts";
import { labels } from "./signals.ts";

// Why an incident opened and what came of it, for the incident page: the monitor's checks around
// the start, the incident's own timeline, and who was told.

const span = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });

/** Most alerts listed per alert-group note; `alertCount` has them all. */
export const EVIDENCE_ALERTS = 20;

/** A monitor incident's monitor, its checks and its state changes in the window. */
const evidenceMonitor = z.object({
  id: monitorId,
  name: z.string(),
  type: z.enum(monitorTypes),
  /** The probe regions. A heartbeat's results all come from the one region that sweeps it. */
  regions: z.array(awsRegion),
  /**
   * From 30 minutes before the start to the resolution, or now. Results inside `gap` are left
   * out: an incident longer than 90 minutes keeps the hour around its start and its latest hour.
   */
  window: span.extend({ gap: span.nullable() }),
  /** Oldest first, one per region that reported each scheduled minute. */
  results: z.array(recentCheck),
  /** Confirmed detection state changes in the whole window, gap included, oldest first. */
  transitions: z.array(
    z.object({ from: z.enum(monitorStates), to: z.enum(monitorStates), at: z.iso.datetime() }),
  ),
});

/** What the timeline records besides public updates, oldest first. */
export const evidenceEntry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status_changed"),
    at: z.iso.datetime(),
    from: z.enum(incidentStatuses).nullable(),
    to: z.enum(incidentStatuses),
  }),
  z.object({
    kind: z.literal("signal"),
    at: z.iso.datetime(),
    integrationId,
    /** Null once the integration is deleted. */
    integrationName: z.string().nullable(),
    title: z.string(),
    status: z.enum(signalStatuses),
    /**
     * The group's first alerts, by their labels; none once the incident's earlier notes have
     * filled the response's room for labels.
     */
    alerts: z.array(labels).max(EVIDENCE_ALERTS),
    alertCount: z.int().nonnegative(),
  }),
]);
export type EvidenceEntry = z.infer<typeof evidenceEntry>;

const count = z.int().nonnegative();

/** One notice about the incident and how each delivery of it went. */
export const evidenceNotice = z.object({
  eventId,
  /** When its first delivery was queued. */
  at: z.iso.datetime(),
  /** Emails to subscribers, by status; addresses stay out. */
  subscribers: z.object({ pending: count, sent: count, failed: count, skipped: count }),
  endpoints: z.array(
    z.object({
      id: webhookEndpointId,
      name: z.string(),
      kind: z.enum(endpointKinds),
      status: z.enum(deliveryStatuses),
      attempts: z.int(),
      lastError: z.string().nullable(),
      sentAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type EvidenceNotice = z.infer<typeof evidenceNotice>;

export const incidentEvidence = z.object({
  /** Null unless a monitor opened the incident and still exists. */
  monitor: evidenceMonitor.nullable(),
  timeline: z.array(evidenceEntry),
  /** Oldest first; null for members below admin, like destinations and subscribers. */
  notifications: z.array(evidenceNotice).nullable(),
});
export type IncidentEvidence = z.infer<typeof incidentEvidence>;
