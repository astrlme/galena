import {
  type IncidentId,
  type SignalIngest,
  type SignalOutcome,
  signalIdempotencyKey,
} from "@galena/contracts";
import type { Incident } from "@galena/core";
import { assertNever, inMaintenance, planSignal, routeAlerts, signalDedupKey } from "@galena/core";
import {
  componentRepository,
  findIntegration,
  hasSignalReceipt,
  incidentRepository,
  maintenanceRepository,
  recordSignalOutcome,
  recordSignalReceipt,
} from "@galena/db";
import { type AutopilotDeps, openIncident, postUpdate } from "./autopilot.ts";

/**
 * After `signal.ingest` takes an alert group from an integration's hook URL: opens an incident on
 * the components the group's routes mark, leaves the group to an incident already open there,
 * or resolves the incident the group opened. Safe to repeat: a notification already acted on
 * (by its idempotency key) changes nothing, the group's dedup key holds one unresolved incident
 * (a dismissed draft included, so a group a person dismissed stays dismissed while it fires),
 * and the resolve applies only while the incident is where it was.
 */
export async function actOnSignal(ingest: SignalIngest, deps: AutopilotDeps) {
  const { integrationId, tokenIssuedAt, signal } = ingest;
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
  const key = signalIdempotencyKey(ingest);
  // A repeat after a person resolved the group's incident would otherwise open a new one.
  if (await hasSignalReceipt(deps.db, key)) {
    await recordSignalOutcome(deps.db, integrationId, "repeat", now);
    return { action: "none" as const, outcome: "repeat" as const };
  }
  const incidents = incidentRepository(deps.db);
  const dedupKey = signalDedupKey(integrationId, signal.fingerprint);
  const routed = routeAlerts(signal.alerts, integration.routes);

  const own = (await incidents.findUnresolved(workspaceId, dedupKey)) ?? null;
  const components = await componentRepository(deps.db).listByWorkspace(workspaceId);
  // Only a firing group without an incident of its own may open one, so only it needs to know
  // what else is open on its components and whether they're in maintenance.
  const mayOpen = signal.status === "firing" && !own;
  const covering = new Map<IncidentId, Incident>();
  let windows: { startsAt: string; endsAt: string }[] = [];
  if (mayOpen) {
    // Known limit: one query per routed component; a route rarely marks more than a few.
    for (const { componentId } of routed) {
      for (const incident of await incidents.openAffecting(workspaceId, componentId)) {
        covering.set(incident.id, incident);
      }
    }
    const routedIds = new Set(routed.map((c) => c.componentId));
    windows = (await maintenanceRepository(deps.db).list(workspaceId))
      .filter((w) => !w.cancelledAt && w.componentIds.some((id) => routedIds.has(id)))
      .map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() }));
  }

  const plan = planSignal({
    status: signal.status,
    dedupKey,
    policy: integration.publishPolicy,
    routed,
    componentNames: new Map(components.map((c) => [c.id, c.name])),
    inMaintenance: inMaintenance(windows, now),
    own,
    covering: [...covering.values()],
    now,
  });

  let outcome: SignalOutcome;
  let incidentId = own?.id;
  switch (plan.action) {
    case "open": {
      const opened = await openIncident(workspaceId, plan, { source: "signal" }, now, deps);
      incidentId = opened.incidentId;
      outcome = opened.created ? "opened" : "repeat";
      break;
    }
    case "attach":
      incidentId = plan.incidentId;
      outcome = "attached";
      break;
    case "update": {
      // planSignal plans an update only on the group's own incident.
      const updated = own ? await postUpdate(workspaceId, own, plan, deps) : undefined;
      outcome = updated?.applied ? "resolved" : "repeat";
      break;
    }
    case "none":
      outcome = plan.outcome;
      break;
    default:
      return assertNever(plan);
  }
  if (incidentId && (outcome === "opened" || outcome === "attached" || outcome === "resolved")) {
    const note = {
      integrationId,
      title: signal.title,
      status: signal.status,
      alerts: signal.alerts,
    };
    await incidents.noteSignal(workspaceId, incidentId, { ...note, key }, now);
  }
  await recordSignalOutcome(deps.db, integrationId, outcome, now);
  // Last, so a run that failed before here acts on the notification when it is retried.
  await recordSignalReceipt(deps.db, { workspaceId, integrationId, key });
  return { action: plan.action, outcome, incidentId };
}
