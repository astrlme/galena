import type {
  AffectedComponent,
  ComponentId,
  DownStatus,
  IncidentId,
  IncidentImpact,
  IncidentStatus,
  MonitorId,
  MonitorState,
  PublishPolicy,
} from "@galena/contracts";
import type { Incident } from "../ports.ts";
import { fillTemplate } from "./templates.ts";

// What autopilot does when a monitor changes state. An outage opens an incident, unless one is
// already open on the component; the monitor's publish policy decides whether it goes out at once
// (`auto`), waits for a person (`approve`), or never reaches the page (`internal_only`). The
// incident a monitor opened then follows it: Monitoring when it recovers, Investigating again if
// it fails before it is stable, and resolved once it is up. Detection's RECOVERING state already
// lasts `stableMinutes`, so no timer is needed.

/** How long an `approve` draft waits for a person before the timeout decides. */
export const APPROVAL_WAIT_MINUTES = 10;
const NEXT_UPDATE_MINUTES = 30;
const MINUTE = 60_000;

export type AutopilotMonitor = {
  id: MonitorId;
  componentId: ComponentId | null;
  componentName: string | null;
  publishPolicy: PublishPolicy;
  /** What the component shows while this monitor is down. */
  downStatus: DownStatus;
  /** How long it stays RECOVERING before it is up. */
  stableMinutes: number;
};

export type AutopilotPlan =
  | {
      action: "none";
      reason: "suppressed" | "not_down" | "internal_only" | "no_component" | "no_incident";
    }
  | { action: "attach"; incidentId: IncidentId }
  | {
      action: "open";
      /** One open incident per monitor: a retried transition finds the one it opened. */
      dedupKey: string;
      visibility: "published" | "draft";
      title: string;
      body: string;
      impact: IncidentImpact;
      components: AffectedComponent[];
      /** A draft publishes at this time unless a person answers first. */
      approvalDeadline: Date | null;
    }
  | {
      /** An update on the incident this monitor opened. */
      action: "update";
      incidentId: IncidentId;
      /** The status it has now; the update applies only while it still does. */
      expected: IncidentStatus;
      status: "investigating" | "monitoring" | "resolved";
      body: string;
    };

/** The monitor's own incidents carry this key; others are never updated by autopilot. */
export const monitorDedupKey = (monitorId: MonitorId) => `mon:${monitorId}`;

const utcTime = (date: Date) => `${date.toISOString().slice(11, 16)} UTC`;
const minutesFrom = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);

export function planAutopilot(input: {
  from: MonitorState;
  to: MonitorState;
  /** Inside a maintenance window. */
  suppressed: boolean;
  monitor: AutopilotMonitor;
  /** Open incidents affecting the monitor's component. */
  openIncidents: readonly Incident[];
  now: Date;
}): AutopilotPlan {
  const { monitor, now, from, to } = input;
  if (input.suppressed) return { action: "none", reason: "suppressed" };
  if (monitor.publishPolicy === "internal_only") return { action: "none", reason: "internal_only" };
  if (monitor.componentId === null || monitor.componentName === null) {
    return { action: "none", reason: "no_component" };
  }
  const component = monitor.componentName;
  const own = input.openIncidents.find((i) => i.dedupKey === monitorDedupKey(monitor.id));
  const investigating = fillTemplate("investigating", {
    symptom: "failed checks",
    component,
    // A monitor is down only when at least two regions agree.
    regions: "more than one region",
    nextUpdate: utcTime(minutesFrom(now, NEXT_UPDATE_MINUTES)),
  });

  if (to === "down") {
    // It failed again before it was stable: the incident goes back to Investigating.
    if (own?.status === "monitoring") {
      return {
        action: "update",
        incidentId: own.id,
        expected: own.status,
        status: "investigating",
        body: investigating,
      };
    }
    const covering = own ?? input.openIncidents[0];
    if (covering) return { action: "attach", incidentId: covering.id };
    const draft = monitor.publishPolicy === "approve";
    return {
      action: "open",
      dedupKey: monitorDedupKey(monitor.id),
      visibility: draft ? "draft" : "published",
      title: `${component} is down`,
      body: investigating,
      impact: "major",
      components: [{ componentId: monitor.componentId, status: monitor.downStatus }],
      approvalDeadline: draft ? minutesFrom(now, APPROVAL_WAIT_MINUTES) : null,
    };
  }

  if (to === "recovering" && (own?.status === "investigating" || own?.status === "identified")) {
    return {
      action: "update",
      incidentId: own.id,
      expected: own.status,
      status: "monitoring",
      body: fillTemplate("monitoring", { component, stableMinutes: String(monitor.stableMinutes) }),
    };
  }

  if (to === "up" && own && own.status !== "resolved" && own.status !== "postmortem") {
    // Coming out of RECOVERING, it has worked since that began.
    const since = from === "recovering" ? minutesFrom(now, -monitor.stableMinutes) : now;
    return {
      action: "update",
      incidentId: own.id,
      expected: own.status,
      status: "resolved",
      body: fillTemplate("resolved", {
        component,
        time: utcTime(since),
        summary: "Checks pass from every region again",
      }),
    };
  }

  // Flapping holds still on purpose, and a degraded monitor shows on its component already.
  return {
    action: "none",
    reason: to === "recovering" || to === "up" ? "no_incident" : "not_down",
  };
}

/**
 * What a waiting draft becomes. A person's answer decides; without one, it publishes only if
 * the monitor is still down (transparency first), and a monitor that recovered meanwhile dismisses it.
 */
export function approvalOutcome(
  answer: "approved" | "dismissed" | "timed_out",
  monitorState: MonitorState,
): "publish" | "dismiss" {
  if (answer === "timed_out") return monitorState === "down" ? "publish" : "dismiss";
  return answer === "approved" ? "publish" : "dismiss";
}
