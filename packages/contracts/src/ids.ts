import { z } from "zod";

// IDs are UUIDv7, generated in the app so they sort by creation time.
// Each entity has its own brand, and only these parsers create one.
const uuidv7 = z.uuid({ version: "v7" });

export const workspaceId = uuidv7.brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceId>;
export const memberId = uuidv7.brand<"MemberId">();
export type MemberId = z.infer<typeof memberId>;
export const pageId = uuidv7.brand<"PageId">();
export type PageId = z.infer<typeof pageId>;
export const componentGroupId = uuidv7.brand<"ComponentGroupId">();
export type ComponentGroupId = z.infer<typeof componentGroupId>;
export const componentId = uuidv7.brand<"ComponentId">();
export type ComponentId = z.infer<typeof componentId>;
export const monitorId = uuidv7.brand<"MonitorId">();
export type MonitorId = z.infer<typeof monitorId>;
export const incidentId = uuidv7.brand<"IncidentId">();
export type IncidentId = z.infer<typeof incidentId>;
export const incidentUpdateId = uuidv7.brand<"IncidentUpdateId">();
export type IncidentUpdateId = z.infer<typeof incidentUpdateId>;
export const timelineEventId = uuidv7.brand<"TimelineEventId">();
export type TimelineEventId = z.infer<typeof timelineEventId>;
export const maintenanceId = uuidv7.brand<"MaintenanceId">();
export type MaintenanceId = z.infer<typeof maintenanceId>;
export const subscriberId = uuidv7.brand<"SubscriberId">();
export type SubscriberId = z.infer<typeof subscriberId>;
export const webhookEndpointId = uuidv7.brand<"WebhookEndpointId">();
export type WebhookEndpointId = z.infer<typeof webhookEndpointId>;
export const deliveryId = uuidv7.brand<"DeliveryId">();
export type DeliveryId = z.infer<typeof deliveryId>;
export const slackInstallationId = uuidv7.brand<"SlackInstallationId">();
export type SlackInstallationId = z.infer<typeof slackInstallationId>;
export const integrationId = uuidv7.brand<"IntegrationId">();
export type IntegrationId = z.infer<typeof integrationId>;
export const signalId = uuidv7.brand<"SignalId">();
export type SignalId = z.infer<typeof signalId>;
export const routingRuleId = uuidv7.brand<"RoutingRuleId">();
export type RoutingRuleId = z.infer<typeof routingRuleId>;
export const apiKeyId = uuidv7.brand<"ApiKeyId">();
export type ApiKeyId = z.infer<typeof apiKeyId>;
export const auditLogId = uuidv7.brand<"AuditLogId">();
export type AuditLogId = z.infer<typeof auditLogId>;
export const outboxId = uuidv7.brand<"OutboxId">();
export type OutboxId = z.infer<typeof outboxId>;
// Event envelope id, also the correlation id carried from probe to delivery.
export const eventId = uuidv7.brand<"EventId">();
export type EventId = z.infer<typeof eventId>;
