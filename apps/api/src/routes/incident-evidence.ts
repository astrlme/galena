import { incidentEvidence, incidentId, type MonitorId, type WorkspaceId } from "@galena/contracts";
import { evidenceWindow, monitorOfIncident, roleAtLeast } from "@galena/core";
import {
  incidentNotices,
  incidentRepository,
  incidentTimeline,
  monitorRepository,
  monitorTransitions,
} from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { json } from "./shared.ts";

const isoSpan = (span: { from: Date; to: Date }) => ({
  from: span.from.toISOString(),
  to: span.to.toISOString(),
});

/** Why an incident opened and what came of it: what the incident page shows before any form. */
export function registerIncidentEvidenceRoutes(app: App, deps: Deps) {
  const { db, telemetry } = deps;
  const viewer = requireRole(deps, "viewer");
  const incidents = incidentRepository(db);
  const monitors = monitorRepository(db);

  /** The monitor's checks and state changes around the incident; null once it is deleted. */
  async function monitorEvidence(
    workspaceId: WorkspaceId,
    id: MonitorId,
    incident: { startedAt: Date; resolvedAt: Date | null },
  ) {
    const monitor = await monitors.findById(workspaceId, id);
    if (!monitor) return null;
    const window = evidenceWindow(incident.startedAt, incident.resolvedAt ?? new Date());
    const [results, transitions] = await Promise.all([
      Promise.all(
        window.reads.map(isoSpan).map(({ from, to }) => telemetry.checksIn(id, from, to)),
      ),
      monitorTransitions(db, workspaceId, id, window),
    ]);
    return {
      id,
      name: monitor.name,
      type: monitor.type,
      regions: [...telemetry.regions],
      window: { ...isoSpan(window), gap: window.gap && isoSpan(window.gap) },
      results: results.flat(),
      transitions,
    };
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}/evidence",
      tags: ["Incidents"],
      summary: "Why an incident opened and who was told",
      description:
        "For an incident a monitor opened: each region's results from 30 minutes before the start to the resolution, or now (an incident longer than 90 minutes keeps the hour around its start and its latest hour), and the monitor's state changes. For every incident: status changes and the alert groups integrations reported about it, with their first 20 alerts' labels. For admins and owners, each notice sent and how its deliveries went.",
      middleware: [viewer],
      request: { params: z.object({ id: incidentId }) },
      responses: { 200: json(incidentEvidence, "The incident's evidence") },
    }),
    async (c) => {
      const { workspaceId, role } = c.get("member");
      const { id } = c.req.valid("param");
      const incident = (await incidents.findById(workspaceId, id)) ?? notFound("Incident");
      const monitorId = monitorOfIncident(incident.dedupKey ?? null);
      const [monitor, timeline, notifications] = await Promise.all([
        monitorId ? monitorEvidence(workspaceId, monitorId, incident) : null,
        incidentTimeline(db, workspaceId, id),
        // Destinations and subscribers are admin-only everywhere else too.
        roleAtLeast(role, "admin") ? incidentNotices(db, workspaceId, id) : null,
      ]);
      return c.json({ monitor, timeline, notifications }, 200);
    },
  );
}
