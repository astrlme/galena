import {
  eventId,
  type IncidentEventType,
  type IncidentId,
  type IncidentImpact,
  type IncidentStatus,
  type IncidentUpdateId,
  type IncidentVisibility,
  incidentId,
  incidentUpdateId,
  type MonitorTransitioned,
  monitorId,
  type OutboxId,
  type WorkspaceId,
  workspaceId,
} from "@galena/contracts";
import {
  type AutopilotPlan,
  applyUpdate,
  approvalOutcome,
  type Clock,
  type Incident,
  planAutopilot,
} from "@galena/core";
import {
  componentRepository,
  type Db,
  findMonitorState,
  incidentRepository,
  monitorRepository,
  recordChange,
} from "@galena/db";
import { v7 } from "uuid";
import { z } from "zod";

/** What `incident.autopilot` waits on: one draft a monitor opened. */
export const draftPayload = z.object({ workspaceId, incidentId, monitorId });
export type DraftPayload = z.infer<typeof draftPayload>;

export type AutopilotDeps = {
  db: Db;
  clock: Clock;
  /** Hands a committed outbox row to `outbox.dispatch`. */
  dispatch: (outboxId: OutboxId) => Promise<void>;
  /** Starts `incident.autopilot` for a draft, keyed `auto:{incidentId}`. */
  awaitApproval: (draft: DraftPayload) => Promise<void>;
};

export type ApprovalDeps = Pick<AutopilotDeps, "db" | "clock" | "dispatch"> & {
  /** Waits durably for a person's answer until the deadline (a waitpoint token). */
  waitForAnswer: (
    draft: DraftPayload & { deadline: Date },
  ) => Promise<"approved" | "dismissed" | "timed_out">;
};

/**
 * After `monitor.state-changed` records a transition: opens an incident for an outage, moves the
 * incident the monitor opened along (Monitoring, Investigating again, resolved), leaves it to the
 * incident already covering the component, or does nothing. Safe to repeat: the monitor's dedup
 * key holds one open incident, an update applies only while the incident is where it was, and
 * the approval run is keyed by the incident.
 */
export async function actOnTransition(
  { workspaceId, data }: MonitorTransitioned,
  deps: AutopilotDeps,
) {
  const monitor = await monitorRepository(deps.db).findById(workspaceId, data.monitorId);
  if (!monitor) return { action: "none" as const, reason: "deleted" as const };
  const component = monitor.componentId
    ? await componentRepository(deps.db).findById(workspaceId, monitor.componentId)
    : undefined;
  const now = deps.clock.now();
  const openIncidents = component
    ? await incidentRepository(deps.db).openAffecting(workspaceId, component.id)
    : [];
  const plan = planAutopilot({
    from: data.from,
    to: data.to,
    suppressed: data.suppressed,
    monitor: {
      id: monitor.id,
      componentId: component?.id ?? null,
      componentName: component?.name ?? null,
      publishPolicy: monitor.publishPolicy,
      downStatus: monitor.downStatus,
      stableMinutes: monitor.detection.stableMinutes,
    },
    openIncidents,
    now,
  });
  if (plan.action === "update") {
    const incident = openIncidents.find((i) => i.id === plan.incidentId);
    return incident ? postUpdate(workspaceId, incident, plan, deps) : plan;
  }
  if (plan.action !== "open") return plan;

  const update = {
    id: incidentUpdateId.parse(v7()),
    status: "investigating" as const,
    body: plan.body,
    createdAt: now,
    createdByUserId: null,
  };
  const opened = await deps.db.transaction(async (tx) => {
    const result = await incidentRepository(tx).createOnce(
      {
        id: incidentId.parse(v7()),
        workspaceId,
        title: plan.title,
        impact: plan.impact,
        visibility: plan.visibility,
        source: "monitor",
        startedAt: now,
        dedupKey: plan.dedupKey,
        approvalDeadline: plan.approvalDeadline,
      },
      {
        update,
        stage: { status: "investigating", resolvedAt: null },
        components: plan.components,
        statusChange: { from: null, to: "investigating" },
      },
    );
    const outboxId = result.created
      ? await recordChange(
          tx,
          incidentChange(
            { workspaceId, incidentId: result.id, updateId: update.id, now },
            "incident.created",
            { status: "investigating", impact: plan.impact, visibility: plan.visibility },
          ),
        )
      : null;
    return { ...result, outboxId };
  });
  // Known limit: if this trigger fails, a retry finds the incident already opened and the row
  // stays pending until the outbox sweep exists.
  if (opened.outboxId) await deps.dispatch(opened.outboxId);
  if (plan.visibility === "draft") {
    await deps.awaitApproval({ workspaceId, incidentId: opened.id, monitorId: monitor.id });
  }
  return {
    action: "open" as const,
    incidentId: opened.id,
    created: opened.created,
    visibility: plan.visibility,
  };
}

/** One update on the incident the monitor opened, if it is still where autopilot found it. */
async function postUpdate(
  workspaceId: WorkspaceId,
  incident: Incident,
  plan: Extract<AutopilotPlan, { action: "update" }>,
  deps: AutopilotDeps,
) {
  const step = applyUpdate(incident, plan.status, deps.clock);
  if (!step.ok) throw new Error(step.error.message); // planAutopilot only plans allowed moves
  const { statusChanged, event, ...stage } = step.value;
  const update = {
    id: incidentUpdateId.parse(v7()),
    status: plan.status,
    body: plan.body,
    createdAt: deps.clock.now(),
    createdByUserId: null,
  };
  const outboxId = await deps.db.transaction(async (tx) => {
    const applied = await incidentRepository(tx).append(workspaceId, incident.id, plan.expected, {
      update,
      stage,
      ...(statusChanged ? { statusChange: { from: plan.expected, to: stage.status } } : {}),
    });
    if (!applied) return null;
    return recordChange(
      tx,
      incidentChange(
        { workspaceId, incidentId: incident.id, updateId: update.id, now: update.createdAt },
        event,
        { status: stage.status, impact: incident.impact, visibility: incident.visibility },
      ),
    );
  });
  if (outboxId) await deps.dispatch(outboxId);
  return {
    action: "update" as const,
    incidentId: incident.id,
    status: plan.status,
    applied: outboxId !== null,
  };
}

/**
 * Waits for a person to approve or dismiss the draft, then publishes or dismisses it. With no
 * answer by the deadline it publishes only if the monitor is still down.
 */
export async function settleDraft(
  payload: DraftPayload,
  deps: ApprovalDeps,
): Promise<"published" | "dismissed" | "decided_elsewhere"> {
  const { workspaceId, incidentId: id, monitorId: monitor } = payload;
  const draft = await incidentRepository(deps.db).findById(workspaceId, id);
  if (draft?.visibility !== "draft" || !draft.approvalDeadline) return "decided_elsewhere";
  const answer = await deps.waitForAnswer({ ...payload, deadline: draft.approvalDeadline });
  const state =
    answer === "timed_out" ? await findMonitorState(deps.db, workspaceId, monitor) : undefined;
  const visibility =
    approvalOutcome(answer, state ?? "unknown") === "publish" ? "published" : "dismissed";
  const latest = draft.updates[0];
  if (!latest) throw new Error(`Draft ${id} has no update.`);
  const outboxId = await deps.db.transaction(async (tx) => {
    if (!(await incidentRepository(tx).decide(workspaceId, id, visibility))) return null;
    return recordChange(
      tx,
      incidentChange(
        { workspaceId, incidentId: id, updateId: latest.id, now: deps.clock.now() },
        "incident.updated",
        { status: draft.status, impact: draft.impact, visibility },
      ),
    );
  });
  if (!outboxId) return "decided_elsewhere";
  await deps.dispatch(outboxId);
  return visibility;
}

/** The audit entry and `incident.*` outbox event for a change autopilot makes, by no person. */
function incidentChange(
  at: { workspaceId: WorkspaceId; incidentId: IncidentId; updateId: IncidentUpdateId; now: Date },
  type: IncidentEventType,
  state: { status: IncidentStatus; impact: IncidentImpact; visibility: IncidentVisibility },
) {
  return {
    workspaceId: at.workspaceId,
    actorUserId: null,
    action: type,
    targetType: "incident",
    targetId: at.incidentId,
    event: {
      id: eventId.parse(v7()),
      type,
      occurredAt: at.now.toISOString(),
      workspaceId: at.workspaceId,
      data: { incidentId: at.incidentId, updateId: at.updateId, ...state },
    },
  };
}
