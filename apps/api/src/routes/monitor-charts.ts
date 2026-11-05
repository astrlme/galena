import { monitorId, monitorSeries, monitorUptime, month, seriesRanges } from "@galena/contracts";
import { monthSpan, seriesWindow } from "@galena/core";
import { countMonitorIncidents, monitorRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { json } from "./shared.ts";

/** What a monitor's charts read: its response times and its month. */
export function registerMonitorChartRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const viewer = requireRole(deps, "viewer");
  const monitors = monitorRepository(db);

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
}
