import {
  type MaintenanceEventType,
  type MaintenanceInput,
  maintenanceId,
  maintenanceInput,
  maintenanceView,
} from "@galena/contracts";
import { cancelMaintenance, canEditMaintenance, type Maintenance } from "@galena/core";
import { componentRepository, maintenanceRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { commit, eventChange, json, jsonBody } from "./shared.ts";

const toView = (m: Maintenance) => ({
  id: m.id,
  title: m.title,
  body: m.body,
  status: m.status,
  startsAt: m.startsAt.toISOString(),
  endsAt: m.endsAt.toISOString(),
  cancelledAt: m.cancelledAt?.toISOString() ?? null,
  componentIds: m.componentIds,
});

const maintenanceChange = (
  member: Member,
  type: MaintenanceEventType,
  { id, version, status }: Pick<Maintenance, "id" | "version" | "status">,
) =>
  eventChange(
    member,
    { type: "maintenance", id },
    { type, data: { maintenanceId: id, version, status } },
  );

/** Thrown inside the transaction so the audit entry and event roll back with the write. */
class Superseded extends Error {}

export function registerMaintenanceRoutes(app: App, deps: Deps) {
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const windows = maintenanceRepository(deps.db);
  const components = componentRepository(deps.db);

  async function validate(member: Member, input: MaintenanceInput) {
    if (Date.parse(input.endsAt) <= Date.now()) {
      fail({
        status: 422,
        code: "window_over",
        title: "Couldn't schedule the window",
        detail: "It ends in the past. Pick an end time that is still to come.",
      });
    }
    if (input.componentIds.length === 0) return;
    const known = new Set(
      (await components.listByWorkspace(member.workspaceId)).map((c) => c.id as string),
    );
    if (input.componentIds.some((id) => !known.has(id))) {
      fail({
        status: 422,
        code: "component_not_found",
        title: "That component does not exist",
        detail: "Pick components from the list. Reload the page if one was just deleted.",
      });
    }
  }

  function conflict(detail: string): never {
    return fail({
      status: 409,
      code: "illegal_transition",
      title: "Couldn't change the window",
      detail,
    });
  }
  const superseded = () =>
    conflict("Someone else changed this window while you were editing. Reload it and try again.");

  /** Runs the write; a false result rolls the whole change back and answers 409. */
  async function write(
    change: Parameters<typeof commit>[1],
    run: (repo: typeof windows) => Promise<boolean>,
  ) {
    let done = false;
    await commit(deps, change, async (tx) => {
      done = await run(maintenanceRepository(tx));
      if (!done) throw new Superseded();
    }).catch((error: unknown) => {
      if (!(error instanceof Superseded)) throw error;
    });
    if (!done) superseded();
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/maintenances",
      summary: "Maintenance windows, newest start first",
      middleware: [viewer],
      responses: { 200: json(z.object({ maintenances: z.array(maintenanceView) }), "Windows") },
    }),
    async (c) => {
      const list = await windows.list(c.get("member").workspaceId);
      return c.json({ maintenances: list.map(toView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/maintenances/{id}",
      summary: "One maintenance window",
      middleware: [viewer],
      request: { params: z.object({ id: maintenanceId }) },
      responses: { 200: json(maintenanceView, "The window") },
    }),
    async (c) => {
      const found = await windows.findById(c.get("member").workspaceId, c.req.valid("param").id);
      return c.json(toView(found ?? notFound("Maintenance window")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/maintenances",
      summary: "Schedule a window; it starts and completes on its own",
      middleware: [editor],
      request: jsonBody(maintenanceInput),
      responses: { 201: json(maintenanceView, "The scheduled window") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      await validate(member, input);
      const window: Omit<Maintenance, "runId"> = {
        ...input,
        id: maintenanceId.parse(v7()),
        workspaceId: member.workspaceId,
        status: "scheduled",
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        version: 1,
        cancelledAt: null,
      };
      await write(maintenanceChange(member, "maintenance.scheduled", window), (repo) =>
        repo.save(window, null),
      );
      return c.json(toView({ ...window, runId: null }), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/maintenances/{id}",
      summary: "Change a window that hasn't completed",
      description: "Send every field. The window's run is replaced to match the new times.",
      middleware: [editor],
      request: { params: z.object({ id: maintenanceId }), ...jsonBody(maintenanceInput) },
      responses: { 200: json(maintenanceView, "The changed window") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const current =
        (await windows.findById(member.workspaceId, id)) ?? notFound("Maintenance window");
      if (!canEditMaintenance(current.status))
        conflict("This window has completed and can't change.");
      await validate(member, input);
      const edited = {
        ...current,
        ...input,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        version: current.version + 1,
      };
      await write(maintenanceChange(member, "maintenance.scheduled", edited), (repo) =>
        repo.save(edited, current.version),
      );
      return c.json(toView(edited), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/maintenances/{id}/cancel",
      summary: "Cancel a window before it starts",
      middleware: [editor],
      request: { params: z.object({ id: maintenanceId }) },
      responses: { 200: json(maintenanceView, "The cancelled window") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const current =
        (await windows.findById(member.workspaceId, id)) ?? notFound("Maintenance window");
      const cancel = cancelMaintenance(current.status);
      if (!cancel.ok) conflict(cancel.error.message);
      const cancelled = { ...current, status: cancel.value.to, cancelledAt: new Date() };
      await write(maintenanceChange(member, cancel.value.event, cancelled), (repo) =>
        repo.transition(
          member.workspaceId,
          id,
          { version: current.version, status: current.status },
          { status: cancelled.status, cancelledAt: cancelled.cancelledAt },
        ),
      );
      return c.json(toView(cancelled), 200);
    },
  );
}
