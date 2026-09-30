import { z } from "zod";
import {
  componentStatuses,
  endpointKinds,
  endpointStates,
  incidentImpacts,
  incidentStatuses,
  maintenanceStatuses,
  subscriberStates,
} from "./enums.ts";
import { componentId, eventId, subscriberId, webhookEndpointId } from "./ids.ts";

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

const followed = z
  .array(componentId)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: "List each component once." });

/** A Slack incoming webhook or an outgoing webhook, as a member adds it. */
export const endpointInput = z
  .object({
    kind: z.enum(endpointKinds),
    name: z.string().trim().min(1, "Give it a name, like the channel it posts to.").max(100),
    url: z.url({ protocol: /^https$/, error: "Use an https:// URL." }).max(2_000),
    componentIds: followed.default([]),
  })
  .refine((e) => e.kind !== "slack" || new URL(e.url).hostname === "hooks.slack.com", {
    message: "Slack incoming webhook URLs start with https://hooks.slack.com/.",
    path: ["url"],
  });
export type EndpointInput = z.infer<typeof endpointInput>;

/** Never the URL or the secret: they are sealed once saved. */
export const endpointView = z.object({
  id: webhookEndpointId,
  kind: z.enum(endpointKinds),
  name: z.string(),
  state: z.enum(endpointStates),
  componentIds: z.array(componentId),
  failingSince: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type EndpointView = z.infer<typeof endpointView>;

/** The signing secret appears once, in this answer, for outgoing webhooks. */
export const endpointCreated = z.object({ endpoint: endpointView, secret: z.string().nullable() });

/** A test message's result: what the endpoint answered. */
export const endpointTestResult = z.object({
  ok: z.boolean(),
  status: z.int(),
  detail: z.string(),
});

/** Addresses stay masked on the dashboard: "a***@example.com". */
export const subscriberView = z.object({
  id: subscriberId,
  email: z.string(),
  state: z.enum(subscriberStates),
  componentIds: z.array(componentId),
  createdAt: z.iso.datetime(),
});
export type SubscriberView = z.infer<typeof subscriberView>;
