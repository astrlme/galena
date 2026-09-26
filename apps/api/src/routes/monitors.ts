import {
  type MonitorConfig,
  type MonitorInput,
  monitorId,
  monitorInput,
  monitorView,
} from "@galena/contracts";
import { componentRepository, monitorRepository, recordChange } from "@galena/db";
import { guard } from "@galena/integrations/net";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { changeOf, json, jsonBody, noContent } from "./shared.ts";

const toView = ({ workspaceId: _, ...view }: MonitorConfig) => view;

export function registerMonitorRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const viewer = requireRole(deps, "viewer");
  const editor = requireRole(deps, "editor");
  const monitors = monitorRepository(db);
  const components = componentRepository(db);

  /** What the schema can't know: the component exists here, and the URL is one we'd check. */
  async function validate(member: Member, input: MonitorInput) {
    if (
      input.componentId !== null &&
      !(await components.findById(member.workspaceId, input.componentId))
    ) {
      fail({
        status: 422,
        code: "component_not_found",
        title: "That component does not exist",
        detail: "Pick a component from the list, or leave the monitor without one.",
      });
    }
    // Names are resolved again at check time; this catches literal addresses early.
    const url = guard.checkUrl(input.http.url);
    if (!url.ok) {
      fail({
        status: 422,
        code: "url_refused",
        title: "Couldn't save the monitor",
        detail: `${url.error.message} Use the public address people reach the service on.`,
      });
    }
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors",
      summary: "Monitors, oldest first",
      middleware: [viewer],
      responses: { 200: json(z.object({ monitors: z.array(monitorView) }), "Every monitor") },
    }),
    async (c) => {
      const list = await monitors.listByWorkspace(c.get("member").workspaceId);
      return c.json({ monitors: list.map(toView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/monitors",
      summary: "Add a monitor; probes pick it up with the next config publish",
      middleware: [editor],
      request: jsonBody(monitorInput),
      responses: { 201: json(monitorView, "The new monitor") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      await validate(member, input);
      const created: MonitorConfig = {
        id: monitorId.parse(v7()),
        workspaceId: member.workspaceId,
        ...input,
      };
      await db.transaction(async (tx) => {
        await monitorRepository(tx).save(created);
        await recordChange(tx, changeOf(member, "monitor", "created", [created.id], input));
      });
      return c.json(toView(created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/monitors/{id}",
      summary: "Replace a monitor's settings",
      description: "Send every field; omitted optional fields fall back to their defaults.",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }), ...jsonBody(monitorInput) },
      responses: { 200: json(monitorView, "The updated monitor") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      await validate(member, input);
      const updated: MonitorConfig = { id, workspaceId: member.workspaceId, ...input };
      await db.transaction(async (tx) => {
        await monitorRepository(tx).save(updated);
        await recordChange(tx, changeOf(member, "monitor", "updated", [id], input));
      });
      return c.json(toView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/monitors/{id}",
      summary: "Delete a monitor; probes stop checking it with the next config publish",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await monitors.findById(member.workspaceId, id)) ?? notFound("Monitor");
      await db.transaction(async (tx) => {
        await monitorRepository(tx).delete(member.workspaceId, id);
        await recordChange(
          tx,
          changeOf(member, "monitor", "deleted", [id], { name: existing.name }),
        );
      });
      return c.body(null, 204);
    },
  );
}
