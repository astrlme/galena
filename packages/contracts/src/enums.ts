// Domain enums. Stored and published values are snake_case and match
// Statuspage where Statuspage defines them. Post-v1 values are added when their feature ships.

export const componentStatuses = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
] as const;
export type ComponentStatus = (typeof componentStatuses)[number];

export const incidentStatuses = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "postmortem",
] as const;
export type IncidentStatus = (typeof incidentStatuses)[number];

export const incidentImpacts = ["none", "minor", "major", "critical"] as const;
export type IncidentImpact = (typeof incidentImpacts)[number];

export const maintenanceStatuses = ["scheduled", "in_progress", "verifying", "completed"] as const;
export type MaintenanceStatus = (typeof maintenanceStatuses)[number];

// Statuspage "status.indicator".
export const pageIndicators = ["none", "minor", "major", "critical"] as const;
export type PageIndicator = (typeof pageIndicators)[number];

export const incidentVisibilities = ["draft", "published", "dismissed", "internal"] as const;
export type IncidentVisibility = (typeof incidentVisibilities)[number];

export const incidentSources = ["manual", "monitor", "signal"] as const; // post-v1: "github", "import"
export type IncidentSource = (typeof incidentSources)[number];

export const publishPolicies = ["auto", "approve", "internal_only"] as const;
export type PublishPolicy = (typeof publishPolicies)[number];

export const monitorTypes = ["http"] as const; // post-v1: "tcp", "dns", "tls_expiry", "domain_expiry", "heartbeat"
export type MonitorType = (typeof monitorTypes)[number];

export const monitorStates = [
  "unknown",
  "up",
  "degraded",
  "down",
  "recovering",
  "flapping",
] as const;
export type MonitorState = (typeof monitorStates)[number];

// `error` means the probe failed, not the target.
export const checkStatuses = ["up", "degraded", "down", "error"] as const;
export type CheckStatus = (typeof checkStatuses)[number];

export const channelKinds = ["email", "slack", "webhook"] as const; // post-v1: "discord", "teams"
export type ChannelKind = (typeof channelKinds)[number];

export const signalSources = ["alertmanager", "generic"] as const; // post-v1: "grafana", "cloudwatch", "sentry"
export type SignalSource = (typeof signalSources)[number];

export const memberRoles = ["owner", "admin", "editor", "viewer"] as const;
export type MemberRole = (typeof memberRoles)[number];
