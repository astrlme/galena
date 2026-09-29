import {
  type ComponentStatus,
  type DownStatus,
  type IncidentComponentStatus,
  type IncidentImpact,
  type IncidentStatus,
  type IncidentVisibility,
  type MonitorState,
  type PageIndicator,
  pageIndicators,
} from "@galena/contracts";
import { assertNever } from "../assert-never.ts";

// Mapping monitor state to component status.

export type { DownStatus };

type MonitorDrivenStatus = Exclude<ComponentStatus, "under_maintenance">;

// Least to most severe.
const SEVERITY: readonly MonitorDrivenStatus[] = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
];

/** One monitor's view of its component; undefined while detection has no opinion yet. */
export function monitorStatus(
  state: MonitorState,
  downStatus: DownStatus,
): MonitorDrivenStatus | undefined {
  switch (state) {
    case "unknown":
      return undefined;
    case "up":
    case "recovering": // the incident stays in `monitoring` until resolve-watch closes it
      return "operational";
    case "degraded":
    case "flapping":
      return "degraded_performance";
    case "down":
      return downStatus;
    default:
      return assertNever(state);
  }
}

/** Only these move the public page: drafts, dismissed and internal incidents never do. */
export function isOpenPublished(incident: {
  status: IncidentStatus;
  visibility: IncidentVisibility;
}): boolean {
  return (
    incident.visibility === "published" &&
    incident.status !== "resolved" &&
    incident.status !== "postmortem"
  );
}

export type ComponentInputs = {
  /** The status before this evaluation, kept while nothing has an opinion. */
  current: ComponentStatus;
  monitors: ReadonlyArray<{ state: MonitorState; downStatus: DownStatus }>;
  /** Incidents naming this component, with the status they give it. */
  incidents: ReadonlyArray<{
    status: IncidentStatus;
    visibility: IncidentVisibility;
    componentStatus: IncidentComponentStatus;
  }>;
  inMaintenance: boolean;
  manualStatus: ComponentStatus | null;
};

/**
 * A member's manual status wins, then an active maintenance window, then the worst of the
 * monitors and the open, published incidents. Resolving an incident removes its say.
 */
export function componentStatus(inputs: ComponentInputs): ComponentStatus {
  if (inputs.manualStatus !== null) return inputs.manualStatus;
  if (inputs.inMaintenance) return "under_maintenance";
  const opinions = [
    ...inputs.monitors.map(({ state, downStatus }) => monitorStatus(state, downStatus)),
    ...inputs.incidents.filter(isOpenPublished).map((i) => i.componentStatus),
  ];
  let worst: MonitorDrivenStatus | undefined;
  for (const status of opinions) {
    if (status && (!worst || SEVERITY.indexOf(status) > SEVERITY.indexOf(worst))) worst = status;
  }
  return worst ?? inputs.current;
}

const INDICATOR_BY_COMPONENT: Record<ComponentStatus, PageIndicator> = {
  operational: "none",
  under_maintenance: "none",
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
};
const INDICATOR_BY_IMPACT: Record<IncidentImpact, PageIndicator> = {
  none: "none",
  minor: "minor",
  major: "major",
  critical: "critical",
};

export type IndicatorIncident = {
  status: IncidentStatus;
  impact: IncidentImpact;
  visibility: IncidentVisibility;
};

/**
 * Statuspage's `status.indicator` for a page: the worst of its components and its unresolved,
 * published incidents. Drafts, dismissed and internal incidents never move the public indicator.
 */
export function pageIndicator(
  components: readonly ComponentStatus[],
  incidents: readonly IndicatorIncident[],
): PageIndicator {
  const indicators = [
    ...components.map((status) => INDICATOR_BY_COMPONENT[status]),
    ...incidents.filter(isOpenPublished).map((i) => INDICATOR_BY_IMPACT[i.impact]),
  ];
  return indicators.reduce<PageIndicator>(
    (worst, next) => (pageIndicators.indexOf(next) > pageIndicators.indexOf(worst) ? next : worst),
    "none",
  );
}
