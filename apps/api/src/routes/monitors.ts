import {
  awsRegion,
  type MonitorConfig,
  type MonitorInput,
  monitorId,
  monitorInput,
  monitorSeries,
  monitorTelemetry,
  monitorUptime,
  monitorView,
  month,
  seriesRanges,
} from "@galena/contracts";
import { monitorStatus, monthSpan, seriesWindow } from "@galena/core";
import { componentRepository, countMonitorIncidents, monitorRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
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
      summary: "Each monitor's state and its results from the last 60 minutes",
      description: "Reads telemetry only; poll it while the monitors page is open.",
      middleware: [viewer],
      responses: {
        200: json(
          z.object({ regions: z.array(awsRegion), monitors: z.array(monitorTelemetry) }),
          "One entry per monitor, oldest monitor first",
        ),
      },
    }),
    async (c) => {
      const list = await monitors.listByWorkspace(c.get("member").workspaceId);
      const readings = await deps.telemetry.read(list.map((m) => m.id));
      const telemetry = list.map((monitor) => {
        const reading = readings.get(monitor.id);
        const state = reading?.state ?? "unknown";
        return {
          id: monitor.id,
          state,
          status: monitorStatus(state, monitor.downStatus) ?? null,
          since: reading?.enteredAt ? new Date(reading.enteredAt).toISOString() : null,
          results: reading?.results ?? [],
        };
      });
      return c.json({ regions: [...deps.telemetry.regions], monitors: telemetry }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/{id}/series",
      tags: ["Monitors"],
      summary: "A monitor's response times per region, for its chart",
      description:
        "`24h` and `7d` give hourly rollups, up to the last whole hour; `30d` and `90d` daily ones, up to yesterday. Each hour is rolled up at five past the next. Median and p95 count answers (up and degraded) only; phases are means, so they add up.",
      middleware: [viewer],
      request: {
        params: z.object({ id: monitorId }),
        query: z.object({ range: z.enum(seriesRanges).default("24h") }),
      },
      responses: { 200: json(monitorSeries, "Points oldest first, then by region") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const { range } = c.req.valid("query");
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      const window = seriesWindow(range, new Date());
      const points = (await deps.telemetry.series(id, window)).toSorted(
        (a, b) => a.at.localeCompare(b.at) || a.region.localeCompare(b.region),
      );
      return c.json({ range, step: window.source, points }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/{id}/uptime",
      tags: ["Monitors"],
      summary: "A monitor's month: minutes checked, minutes down, incidents it opened",
      description:
        "A minute is down when a quorum of regions failed it. Maintenance is not taken out. The month defaults to the current one (UTC); each hour counts once rolled up, at five past the next.",
      middleware: [viewer],
      request: {
        params: z.object({ id: monitorId }),
        query: z.object({ month: month.optional() }),
      },
      responses: { 200: json(monitorUptime, "The month's minutes and incidents") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const now = new Date().toISOString();
      const asked = c.req.valid("query").month ?? now.slice(0, 7);
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      const minutes = await deps.telemetry.minutes(id, asked, now.slice(0, 10));
      const incidents = await countMonitorIncidents(db, member.workspaceId, id, monthSpan(asked));
      return c.json(
        { month: asked, minutes: minutes.minutes, minutesDown: minutes.down, incidents },
        200,
      );
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
