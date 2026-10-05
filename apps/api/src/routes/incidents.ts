import {
  type AffectedComponent,
  type IncidentEventType,
  type IncidentUpdateId,
  incidentCreate,
  incidentDecision,
  incidentId,
  incidentSummary,
  incidentUpdateCreate,
  incidentUpdateId,
  incidentView,
} from "@galena/contracts";
import {
  applyUpdate,
  checkUpdateBody,
  type Incident,
  type IncidentChange,
  type IncidentUpdate,
  startIncident,
} from "@galena/core";
import { componentRepository, incidentRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { commit, eventChange, json, jsonBody } from "./shared.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;
const toSummary = (i: Incident) => ({
  id: i.id,
  title: i.title,
  status: i.status,
  impact: i.impact,
  visibility: i.visibility,
  source: i.source,
  startedAt: i.startedAt.toISOString(),
  resolvedAt: iso(i.resolvedAt),
  updatedAt: i.updatedAt.toISOString(),
  components: i.components,
  approvalDeadline: iso(i.approvalDeadline ?? null),
});
const toView = (i: Incident & { updates: IncidentUpdate[] }) => ({
  ...toSummary(i),
  updates: i.updates.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
});

/** The audit entry and the `incident.*` outbox event for one change and the update it posts. */
const incidentChange = (
  member: Member,
  type: IncidentEventType,
  { id, status, impact, visibility }: Pick<Incident, "id" | "status" | "impact" | "visibility">,
  updateId: IncidentUpdateId,
) =>
  eventChange(
    member,
    { type: "incident", id },
    { type, data: { incidentId: id, updateId, status, impact, visibility } },
  );

/** Thrown inside the transaction so the audit entry and event roll back with the update. */
class StaleIncident extends Error {}

export function registerIncidentRoutes(app: App, deps: Deps) {
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const incidents = incidentRepository(deps.db);
  const components = componentRepository(deps.db);
  const clock = { now: () => new Date() };

  /** What the schema can't know: the words are safe to publish and the components exist. */
  async function validate(member: Member, body: string, affected?: AffectedComponent[]) {
    const checked = checkUpdateBody(body);
    if (!checked.ok) {
      fail({
        status: 422,
        code: checked.error.code,
        title: "Couldn't post the update",
        detail: checked.error.message,
      });
    }
    if (!affected?.length) return;
    const known = new Set(
      (await components.listByWorkspace(member.workspaceId)).map((c) => c.id as string),
    );
    if (affected.some((a) => !known.has(a.componentId))) {
      fail({
        status: 422,
        code: "component_not_found",
        title: "That component does not exist",
        detail: "Pick components from the list. Reload the page if one was just deleted.",
      });
    }
  }

  function moved(detail: string): never {
    return fail({
      status: 409,
      code: "illegal_transition",
      title: "Couldn't change the status",
      detail,
    });
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents",
      tags: ["Incidents"],
      summary: "Open incidents, or recently resolved ones; newest first",
      middleware: [viewer],
      request: { query: z.object({ state: z.enum(["open", "resolved"]).default("open") }) },
      responses: { 200: json(z.object({ incidents: z.array(incidentSummary) }), "Incidents") },
    }),
    async (c) => {
      const { state } = c.req.valid("query");
      const list = await incidents.list(c.get("member").workspaceId, { open: state === "open" });
      return c.json({ incidents: list.map(toSummary) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}",
      tags: ["Incidents"],
      summary: "One incident with its updates, newest first",
      middleware: [viewer],
      request: { params: z.object({ id: incidentId }) },
      responses: { 200: json(incidentView, "The incident") },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const found = await incidents.findById(c.get("member").workspaceId, id);
      return c.json(toView(found ?? notFound("Incident")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents",
      tags: ["Incidents"],
      summary: "Publish an incident with its first update",
      middleware: [editor],
      request: jsonBody(incidentCreate),
      responses: { 201: json(incidentView, "The new incident") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      await validate(member, input.body, input.components);
      const started = startIncident(input.status, clock);
      if (!started.ok) moved(started.error.message);
      const now = clock.now();
      const row = {
        id: incidentId.parse(v7()),
        workspaceId: member.workspaceId,
        title: input.title,
        impact: input.impact,
        visibility: "published" as const,
        source: "manual" as const,
        startedAt: now,
      };
      const first: IncidentChange = {
        update: {
          id: incidentUpdateId.parse(v7()),
          status: input.status,
          body: input.body,
          createdAt: now,
          createdByUserId: member.userId,
        },
        stage: started.value,
        components: input.components,
        statusChange: { from: null, to: input.status },
      };
      await commit(
        deps,
        incidentChange(member, "incident.created", { ...row, ...started.value }, first.update.id),
        (tx) => incidentRepository(tx).create(row, first),
      );
      const created = await incidents.findById(member.workspaceId, row.id);
      return c.json(toView(created ?? notFound("Incident")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/updates",
      tags: ["Incidents"],
      summary: "Post an update; its status moves the incident along its lifecycle",
      description: "Impact and components change only when they are sent.",
      middleware: [editor],
      request: { params: z.object({ id: incidentId }), ...jsonBody(incidentUpdateCreate) },
      responses: { 201: json(incidentView, "The incident with the new update") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const current = (await incidents.findById(member.workspaceId, id)) ?? notFound("Incident");
      await validate(member, input.body, input.components);
      const step = applyUpdate(current, input.status, clock);
      if (!step.ok) moved(step.error.message);
      const { statusChanged, event, ...stage } = step.value;
      const change: IncidentChange = {
        update: {
          id: incidentUpdateId.parse(v7()),
          status: input.status,
          body: input.body,
          createdAt: clock.now(),
          createdByUserId: member.userId,
        },
        stage,
        ...(input.impact ? { impact: input.impact } : {}),
        ...(input.components ? { components: input.components } : {}),
        ...(statusChanged ? { statusChange: { from: current.status, to: stage.status } } : {}),
      };
      const after = { ...current, ...stage, impact: input.impact ?? current.impact };
      let applied = false;
      await commit(deps, incidentChange(member, event, after, change.update.id), async (tx) => {
        applied = await incidentRepository(tx).append(
          member.workspaceId,
          id,
          current.status,
          change,
        );
        // Roll back the audit entry and the event too.
        if (!applied) throw new StaleIncident();
      }).catch((error: unknown) => {
        if (!(error instanceof StaleIncident)) throw error;
      });
      if (!applied) {
        moved(
          "Someone else updated this incident while you were writing. Reload it and post again.",
        );
      }
      const updated = await incidents.findById(member.workspaceId, id);
      return c.json(toView(updated ?? notFound("Incident")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/decision",
      tags: ["Incidents"],
      summary: "Publish or dismiss a draft a monitor opened, before its deadline",
      description:
        "Only a draft can be decided. The monitor's own run finds it decided when its deadline comes.",
      middleware: [editor],
      request: { params: z.object({ id: incidentId }), ...jsonBody(incidentDecision) },
      responses: { 200: json(incidentView, "The incident, published or dismissed") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const { decision } = c.req.valid("json");
      const draft = (await incidents.findById(member.workspaceId, id)) ?? notFound("Incident");
      const latest = draft.updates[0];
      if (draft.visibility !== "draft" || !latest) notDraft();
      const visibility = decision === "publish" ? "published" : "dismissed";
      let decided = false;
      await commit(
        deps,
        incidentChange(member, "incident.updated", { ...draft, visibility }, latest.id),
        async (tx) => {
          decided = await incidentRepository(tx).decide(member.workspaceId, id, visibility);
          // Roll back the audit entry and the event too.
          if (!decided) throw new StaleIncident();
        },
      ).catch((error: unknown) => {
        if (!(error instanceof StaleIncident)) throw error;
      });
      if (!decided) notDraft();
      const after = await incidents.findById(member.workspaceId, id);
      return c.json(toView(after ?? notFound("Incident")), 200);
    },
  );
}

/** Published, dismissed or internal already, by a person or by the deadline. */
function notDraft(): never {
  return fail({
    status: 409,
    code: "not_a_draft",
    title: "Not a draft",
    detail: "This incident was already published or dismissed. Reload it to see where it stands.",
  });
}
