import type { SignalIngest, SignalOutcome } from "@galena/contracts";
import type { Incident, SignalNote } from "@galena/core";
import { inMaintenance, planSignal, routeAlerts, signalDedupKey } from "@galena/core";
import {
  componentRepository,
  findIntegration,
  incidentRepository,
  maintenanceRepository,
  recordSignalOutcome,
} from "@galena/db";
import { type AutopilotDeps, openIncident, postUpdate } from "./autopilot.ts";

/**
 * After `signal.ingest` takes an alert group from an integration's hook URL: opens an incident on
 * the components the group's routes mark, leaves the group to an incident already open there,
 * or resolves the incident the group opened. Safe to repeat: the group's dedup key holds one
 * open incident, and the resolve applies only while the incident is where it was.
 */
export async function actOnSignal(
  { integrationId, tokenIssuedAt, signal }: SignalIngest,
  deps: AutopilotDeps,
) {
  const integration = await findIntegration(deps.db, integrationId);
  // Deleted, or sent to a URL that a newer one has replaced.
  if (
    !integration ||
    integration.source !== signal.source ||
    integration.tokenIssuedAt.getTime() !== Date.parse(tokenIssuedAt)
  ) {
    return { action: "none" as const, outcome: "revoked" as const };
  }
  const { workspaceId } = integration;
  const now = deps.clock.now();
  const incidents = incidentRepository(deps.db);
  const dedupKey = signalDedupKey(integrationId, signal.fingerprint);
  const routed = routeAlerts(signal.alerts, integration.routes);
  const routedIds = new Set(routed.map((c) => c.componentId));

  const own = (await incidents.findOpen(workspaceId, dedupKey)) ?? null;
  const covering = new Map<string, Incident>();
  for (const { componentId } of routed) {
    for (const incident of await incidents.openAffecting(workspaceId, componentId)) {
      if (incident.id !== own?.id) covering.set(incident.id, incident);
    }
  }
  const components = await componentRepository(deps.db).listByWorkspace(workspaceId);
  const windows = (await maintenanceRepository(deps.db).list(workspaceId)).filter(
    (w) => !w.cancelledAt && w.componentIds.some((id) => routedIds.has(id)),
  );

  const plan = planSignal({
    status: signal.status,
    dedupKey,
    policy: integration.publishPolicy,
    routed,
    componentNames: new Map(components.map((c) => [c.id, c.name])),
    inMaintenance: inMaintenance(
      windows.map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
      now,
    ),
    own,
    covering: [...covering.values()],
    now,
  });

  const note: SignalNote = {
    integrationId,
    title: signal.title,
    status: signal.status,
    alerts: signal.alerts,
  };
  let outcome: SignalOutcome;
  let incidentId = own?.id;
  if (plan.action === "open") {
    const opened = await openIncident(workspaceId, plan, { source: "signal" }, now, deps);
    incidentId = opened.incidentId;
    outcome = opened.created ? "opened" : "repeat";
  } else if (plan.action === "attach") {
    incidentId = plan.incidentId;
    outcome = "attached";
  } else if (plan.action === "update" && own) {
    await postUpdate(workspaceId, own, plan, deps);
    outcome = "resolved";
  } else {
    outcome = plan.action === "none" ? plan.outcome : "repeat";
  }
  if (incidentId && outcome !== "repeat") {
    await incidents.noteSignal(workspaceId, incidentId, note, now);
  }
  await recordSignalOutcome(deps.db, integrationId, outcome, now);
  return { action: plan.action, outcome, incidentId };
}
