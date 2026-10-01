import {
  componentStatusLabels,
  componentStatusSymbols,
  incidentImpactLabels,
  incidentStatusLabels,
  maintenanceStatusLabels,
  pageIndicatorStates,
} from "./copy.ts";
import type { ComponentStatus } from "./enums.ts";
import type { Notice } from "./notifications.ts";

// The words of a notice, the same in an email, a Slack message and anywhere else it is read.

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const two = (n: number) => String(n).padStart(2, "0");

/** "30 Sep 2026, 10:00 UTC" */
export function utcDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** The end of a window: only the time when it ends the day it starts. */
function until(startsAt: string, endsAt: string): string {
  const full = utcDateTime(endsAt);
  return utcDateTime(startsAt).split(",")[0] === full.split(",")[0]
    ? (full.split(", ")[1] ?? full)
    : full;
}

const isMaintenance = (n: Notice) => n.kind.startsWith("maintenance_");
const names = (n: Notice) => n.components.map((c) => c.name).join(", ");

/**
 * The state a notice is drawn in: an open incident's worst component state (or what its impact
 * stands for), operational once resolved or completed, maintenance otherwise.
 */
export function noticeState(n: Notice): ComponentStatus {
  switch (n.kind) {
    case "incident_created":
    case "incident_updated": {
      const states = n.components.flatMap((c) => (c.status ? [c.status] : []));
      const order = Object.keys(componentStatusLabels);
      const worst = states.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
      return worst ?? pageIndicatorStates[n.impact ?? "none"];
    }
    case "incident_resolved":
    case "maintenance_completed":
      return "operational";
    default:
      return "under_maintenance";
  }
}

/** Glyph, state and what it is about: "▲ Partial outage: API". */
export function noticeSubject(n: Notice): string {
  const about = names(n) || n.title;
  switch (n.kind) {
    case "incident_created":
    case "incident_updated": {
      const state = noticeState(n);
      return `${componentStatusSymbols[state]} ${componentStatusLabels[state]}: ${about}`;
    }
    case "incident_resolved":
      return `${componentStatusSymbols.operational} Resolved: ${about}`;
    case "maintenance_scheduled":
      return `${componentStatusSymbols.under_maintenance} Maintenance scheduled: ${n.title}`;
    case "maintenance_started":
      return `${componentStatusSymbols.under_maintenance} Maintenance started: ${n.title}`;
    case "maintenance_completed":
      return `${componentStatusSymbols.operational} Maintenance completed: ${n.title}`;
    case "maintenance_cancelled":
      return `${componentStatusSymbols.under_maintenance} Maintenance cancelled: ${n.title}`;
  }
}

/** What stage it is at and when: "Identified. Major impact. Started 30 Sep 2026, 10:00 UTC." */
export function noticeStatusLine(n: Notice): string {
  if (isMaintenance(n)) {
    const status = maintenanceStatusLabels[n.status as keyof typeof maintenanceStatusLabels];
    return `${status}. ${utcDateTime(n.startsAt)} to ${n.endsAt ? until(n.startsAt, n.endsAt) : "further notice"}.`;
  }
  const status = incidentStatusLabels[n.status as keyof typeof incidentStatusLabels];
  const impact = incidentImpactLabels[n.impact ?? "none"];
  const resolved = n.endsAt ? ` Resolved ${utcDateTime(n.endsAt)}.` : "";
  return `${status}. ${impact}. Started ${utcDateTime(n.startsAt)}.${resolved}`;
}

/** Who is affected: "Affected: API (Partial outage), Web (Degraded performance)". */
export function noticeAffected(n: Notice): string | null {
  if (n.components.length === 0) return null;
  const parts = n.components.map((c) =>
    c.status ? `${c.name} (${componentStatusLabels[c.status]})` : c.name,
  );
  return `${isMaintenance(n) ? "Components" : "Affected"}: ${parts.join(", ")}`;
}

/** The update or the window's message, as paragraphs. */
export const noticeParagraphs = (n: Notice) =>
  n.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
