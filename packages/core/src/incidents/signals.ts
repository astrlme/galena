import type {
  AffectedComponent,
  ComponentId,
  IntegrationId,
  Labels,
  PublishPolicy,
  Route,
  SignalOutcome,
  SignalStatus,
} from "@galena/contracts";
import type { Incident } from "../ports.ts";
import {
  APPROVAL_WAIT_MINUTES,
  type AutopilotPlan,
  minutesFrom,
  NEXT_UPDATE_MINUTES,
  utcTime,
} from "./autopilot.ts";
import { fillTemplate } from "./templates.ts";

// What autopilot does with an alert group from an integration. A firing group opens one
// incident on the components its routes mark, unless one is already open there; the
// integration's publish policy decides as it does for a monitor. The group's resolve message
// resolves the incident it opened. Alert names and labels stay internal: the text customers
// see names only components.

export type SignalPlan =
  | {
      action: "none";
      outcome: Extract<
        SignalOutcome,
        "repeat" | "no_incident" | "no_route" | "suppressed" | "internal_only"
      >;
    }
  | Extract<AutopilotPlan, { action: "attach" | "open" | "update" }>;

/** One open incident per alert group: every notification about the group finds it. */
export const signalDedupKey = (integrationId: IntegrationId, fingerprint: string) =>
  `sig:${integrationId}:${fingerprint}`;

const worse = (a: AffectedComponent["status"], b: AffectedComponent["status"]) =>
  a === "major_outage" || b === "major_outage" ? "major_outage" : a;

/**
 * The components the alerts mark: each alert takes the first route whose labels all match its
 * own, and a component marked by several alerts keeps the worst status.
 */
export function routeAlerts(
  alerts: readonly Labels[],
  routes: readonly Route[],
): AffectedComponent[] {
  const marked = new Map<ComponentId, AffectedComponent["status"]>();
  for (const labels of alerts) {
    const route = routes.find((r) => Object.entries(r.match).every(([k, v]) => labels[k] === v));
    if (!route) continue;
    for (const id of route.componentIds) {
      const before = marked.get(id);
      marked.set(id, before ? worse(before, route.downStatus) : route.downStatus);
    }
  }
  return [...marked].map(([componentId, status]) => ({ componentId, status }));
}

/** "API", "API and Database", "API, Database and Web". */
const nameList = (names: readonly string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function planSignal(input: {
  status: SignalStatus;
  dedupKey: string;
  policy: PublishPolicy;
  /** What the group's routes mark now. */
  routed: readonly AffectedComponent[];
  /** Every component that still exists; routes may name deleted ones. */
  componentNames: ReadonlyMap<ComponentId, string>;
  /** A routed component is inside a maintenance window. */
  inMaintenance: boolean;
  /** The open incident this group opened, found by `dedupKey`. */
  own: Incident | null;
  /** Other open incidents on the routed components. */
  covering: readonly Incident[];
  now: Date;
}): SignalPlan {
  const { own, now, componentNames } = input;
  const named = (ids: readonly ComponentId[]) =>
    nameList(ids.flatMap((id) => componentNames.get(id) ?? []));

  if (input.status === "resolved") {
    // What it opened, it resolves, whatever its routes, policy or maintenance say by now.
    if (!own || own.status === "resolved" || own.status === "postmortem") {
      return { action: "none", outcome: "no_incident" };
    }
    return {
      action: "update",
      incidentId: own.id,
      expected: own.status,
      status: "resolved",
      body: fillTemplate("resolved", {
        component: named(own.components.map((c) => c.componentId)),
        time: utcTime(now),
        summary: "Our alerts have cleared",
      }),
    };
  }

  if (own) return { action: "none", outcome: "repeat" };
  if (input.policy === "internal_only") return { action: "none", outcome: "internal_only" };
  if (input.inMaintenance) return { action: "none", outcome: "suppressed" };
  const components = input.routed.filter((c) => componentNames.has(c.componentId));
  if (components.length === 0) return { action: "none", outcome: "no_route" };
  // An internal incident tells nobody outside, so the integration's policy still decides.
  const covering = input.covering.find((i) => i.visibility !== "internal");
  if (covering) return { action: "attach", incidentId: covering.id };

  const names = named(components.map((c) => c.componentId));
  const draft = input.policy === "approve";
  return {
    action: "open",
    dedupKey: input.dedupKey,
    visibility: draft ? "draft" : "published",
    title: `${names} ${components.length > 1 ? "are" : "is"} down`,
    body: fillTemplate("investigating", {
      symptom: "errors",
      component: names,
      regions: "our monitoring",
      nextUpdate: utcTime(minutesFrom(now, NEXT_UPDATE_MINUTES)),
    }),
    impact: "major",
    components,
    approvalDeadline: draft ? minutesFrom(now, APPROVAL_WAIT_MINUTES) : null,
  };
}
