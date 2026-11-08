import { evidenceWindow } from "@galena/core";
import type { Answer, demoData } from "./data.ts";

// A demo incident's evidence: its monitor's last hour as the window shows it, and one notice per
// published update, delivered everywhere but the failing endpoint.

type Data = ReturnType<typeof demoData>;
type Evidence = Answer<"/v1/incidents/{id}/evidence">;
const TIMEOUT = { code: "timeout" as const, message: "No complete response within 10000 ms." };

/** The answer to GET /v1/incidents/{id}/evidence for a demo incident; undefined for none. */
export function evidenceAnswer(data: Data, incidentId: string, now: Date): Evidence | undefined {
  const incident = data.incidents.find((i) => i.id === incidentId);
  if (!incident) return undefined;
  // The demo's incidents carry no dedup key: a monitor's is the one on its component.
  const index =
    incident.source === "monitor"
      ? data.monitors.monitors.findIndex((m) =>
          incident.components.some((c) => c.componentId === m.componentId),
        )
      : -1;
  const monitor = data.monitors.monitors[index];
  const reading = data.telemetry.monitors[index];
  const window = evidenceWindow(
    new Date(incident.startedAt),
    new Date(incident.resolvedAt ?? now.toISOString()),
  );
  const iso = (d: Date) => d.toISOString();
  const read = (at: string) =>
    window.reads.some((span) => at >= iso(span.from) && at <= iso(span.to));
  const results = (reading?.results ?? [])
    .filter((r) => read(r.scheduledAt))
    .map((r) => ({ ...r, error: r.status === "down" ? TIMEOUT : null }))
    .toSorted((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
  const firstDown = results.find((r) => r.status === "down");
  const published = incident.visibility === "published";
  return {
    monitor:
      monitor && reading
        ? {
            id: monitor.id,
            name: monitor.name,
            type: monitor.type,
            regions: data.telemetry.regions,
            window: {
              from: iso(window.from),
              to: iso(window.to),
              gap: window.gap && { from: iso(window.gap.from), to: iso(window.gap.to) },
            },
            results,
            transitions: firstDown ? [{ from: "up", to: "down", at: incident.startedAt }] : [],
          }
        : null,
    timeline: [],
    notifications: published
      ? incident.updates.toReversed().map((u, n) => ({
          eventId: `01920000-0000-7000-8000-${(0x900 + n).toString(16).padStart(12, "0")}`,
          at: u.createdAt,
          subscribers: { pending: 0, sent: data.subscribers.length, failed: 0, skipped: 0 },
          endpoints: data.webhookEndpoints.map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            status: e.state === "failing" ? ("failed" as const) : ("sent" as const),
            attempts: e.state === "failing" ? 3 : 1,
            lastError: e.state === "failing" ? "The endpoint answered HTTP 503." : null,
            sentAt: e.state === "failing" ? null : u.createdAt,
          })),
        }))
      : [],
  };
}
