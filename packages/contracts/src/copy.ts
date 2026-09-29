import type {
  ComponentStatus,
  IncidentImpact,
  IncidentStatus,
  MaintenanceStatus,
  PageIndicator,
} from "./enums.ts";

// The words people read for each stored value, the same on every surface.

export const componentStatusLabels: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Maintenance",
};

export const pageIndicatorLabels: Record<PageIndicator, string> = {
  none: "All systems operational",
  minor: "Some systems degraded",
  major: "Partial outage",
  critical: "Major outage",
};

/** The component state a page indicator is drawn with. */
export const pageIndicatorStates: Record<PageIndicator, ComponentStatus> = {
  none: "operational",
  minor: "degraded_performance",
  major: "partial_outage",
  critical: "major_outage",
};

export const incidentStatusLabels: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  postmortem: "Postmortem",
};

export const incidentImpactLabels: Record<IncidentImpact, string> = {
  none: "No impact",
  minor: "Minor impact",
  major: "Major impact",
  critical: "Critical impact",
};

export const maintenanceStatusLabels: Record<MaintenanceStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  verifying: "Verifying",
  completed: "Completed",
};
