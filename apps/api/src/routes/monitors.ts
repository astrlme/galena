import {
  awsRegion,
  type MonitorConfig,
  type MonitorInput,
  monitorId,
  monitorInput,
  monitorsEnabledInput,
  monitorTelemetry,
  monitorView,
} from "@galena/contracts";
import { monitorStatus } from "@galena/core";
import { componentRepository, monitorRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import { RECENT_MINUTES } from "../telemetry.ts";
import { assertUnderCap, CAPS, changeOf, commit, json, jsonBody, noContent } from "./shared.ts";

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
    const url = deps.targets.checkUrl(input.http.url);
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
      tags: ["Monitors"],
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
      method: "get",
      path: "/v1/monitors/telemetry",
      tags: ["Monitors"],
      summary: "Each monitor's state, its newest results and its last day and month",
      description:
        "Reads telemetry only; poll it while the monitors page is open. `minutes` limits the results to that many of the newest scheduled minutes (60 by default). The summary is rolled up hourly, at five past.",
      middleware: [viewer],
      request: {
        query: z.object({
          minutes: z.coerce.number().int().min(1).max(RECENT_MINUTES).default(RECENT_MINUTES),
        }),
      },
      responses: {
        200: json(
          z.object({ regions: z.array(awsRegion), monitors: z.array(monitorTelemetry) }),
          "One entry per monitor, oldest monitor first",
        ),
      },
    }),
    async (c) => {
      const list = await monitors.listByWorkspace(c.get("member").workspaceId);
      const { minutes } = c.req.valid("query");
      const readings = await deps.telemetry.read(
        list.map((m) => m.id),
        minutes,
      );
      const telemetry = list.map((monitor) => {
        const reading = readings.get(monitor.id);
        const state = reading?.state ?? "unknown";
        return {
          id: monitor.id,
          state,
          status: monitorStatus(state, monitor.downStatus) ?? null,
          since: reading?.enteredAt ? new Date(reading.enteredAt).toISOString() : null,
          results: reading?.results ?? [],
          summary: reading?.summary ?? null,
        };
      });
      return c.json({ regions: [...deps.telemetry.regions], monitors: telemetry }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/monitors",
      tags: ["Monitors"],
      summary: "Add a monitor; probes pick it up with the next config publish",
      middleware: [editor],
      request: jsonBody(monitorInput),
      responses: { 201: json(monitorView, "The new monitor") },
    }),
    async (c) => {
      const member = c.get("member");
      const input = c.req.valid("json");
      assertUnderCap(
        "monitors",
        (await monitors.listByWorkspace(member.workspaceId)).length,
        CAPS.monitors,
      );
      await validate(member, input);
      const created: MonitorConfig = {
        id: monitorId.parse(v7()),
        workspaceId: member.workspaceId,
        ...input,
      };
      await commit(deps, changeOf(member, "monitor", "created", [created.id], input), (tx) =>
        monitorRepository(tx).save(created),
      );
      return c.json(toView(created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/monitors/{id}",
      tags: ["Monitors"],
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
      await commit(deps, changeOf(member, "monitor", "updated", [id], input), (tx) =>
        monitorRepository(tx).save(updated),
      );
      return c.json(toView(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/monitors",
      tags: ["Monitors"],
      summary: "Pause or resume several monitors at once",
      description:
        "Every id must be one of this workspace's monitors, or nothing changes. Probes pick the change up with the next config publish.",
      middleware: [editor],
      request: jsonBody(monitorsEnabledInput),
      responses: {
        200: json(z.object({ monitors: z.array(monitorView) }), "Those monitors as they are now"),
      },
    }),
    async (c) => {
      const member = c.get("member");
      const { ids, enabled } = c.req.valid("json");
      const wanted = new Set(ids);
      const found = (await monitors.listByWorkspace(member.workspaceId)).filter((m) =>
        wanted.has(m.id),
      );
      if (found.length < wanted.size) notFound("Monitor");
      const changed = found.filter((m) => m.enabled !== enabled).map((m) => ({ ...m, enabled }));
      if (changed.length > 0) {
        const changedIds = changed.map((m) => m.id);
        await commit(
          deps,
          changeOf(member, "monitor", "updated", changedIds, { enabled, ids: changedIds }),
          async (tx) => {
            for (const monitor of changed) await monitorRepository(tx).save(monitor);
          },
        );
      }
      return c.json({ monitors: found.map((m) => toView({ ...m, enabled })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/monitors/{id}",
      tags: ["Monitors"],
      summary: "Delete a monitor; probes stop checking it with the next config publish",
      middleware: [editor],
      request: { params: z.object({ id: monitorId }) },
      responses: noContent,
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const existing = (await monitors.findById(member.workspaceId, id)) ?? notFound("Monitor");
      await commit(
        deps,
        changeOf(member, "monitor", "deleted", [id], { name: existing.name }),
        (tx) => monitorRepository(tx).delete(member.workspaceId, id),
      );
      return c.body(null, 204);
    },
  );
}
