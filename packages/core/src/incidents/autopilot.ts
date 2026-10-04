import type {
  AffectedComponent,
  ComponentId,
  DownStatus,
  IncidentId,
  IncidentImpact,
  MonitorId,
  MonitorState,
  PublishPolicy,
} from "@galena/contracts";
import type { Incident } from "../ports.ts";
import { fillTemplate } from "./templates.ts";

// What autopilot does when a monitor changes state: open an incident for an outage, or leave it
// to the incident already covering the component. The monitor's publish policy decides whether
// the incident goes out at once (`auto`), waits for a person (`approve`), or never reaches the
// page at all (`internal_only`).

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
};

export type AutopilotPlan =
  | { action: "none"; reason: "suppressed" | "not_down" | "internal_only" | "no_component" }
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
    };

const utcTime = (date: Date) => `${date.toISOString().slice(11, 16)} UTC`;

export function planAutopilot(input: {
  to: MonitorState;
  /** Inside a maintenance window. */
  suppressed: boolean;
  monitor: AutopilotMonitor;
  /** Open incidents affecting the monitor's component. */
  openIncidents: readonly Incident[];
  now: Date;
}): AutopilotPlan {
  const { monitor, now } = input;
  if (input.suppressed) return { action: "none", reason: "suppressed" };
  // Flapping holds still on purpose, and a degraded monitor shows on its component already.
  if (input.to !== "down") return { action: "none", reason: "not_down" };
  if (monitor.publishPolicy === "internal_only") return { action: "none", reason: "internal_only" };
  if (monitor.componentId === null || monitor.componentName === null) {
    return { action: "none", reason: "no_component" };
  }
  const covering = input.openIncidents[0];
  if (covering) return { action: "attach", incidentId: covering.id };

  const draft = monitor.publishPolicy === "approve";
  return {
    action: "open",
    dedupKey: `mon:${monitor.id}`,
    visibility: draft ? "draft" : "published",
    title: `${monitor.componentName} is down`,
    body: fillTemplate("investigating", {
      symptom: "failed checks",
      component: monitor.componentName,
      // A monitor is down only when at least two regions agree.
      regions: "more than one region",
      nextUpdate: utcTime(new Date(now.getTime() + NEXT_UPDATE_MINUTES * MINUTE)),
    }),
    impact: "major",
    components: [{ componentId: monitor.componentId, status: monitor.downStatus }],
    approvalDeadline: draft ? new Date(now.getTime() + APPROVAL_WAIT_MINUTES * MINUTE) : null,
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
