import {
  type IncidentId,
  monitorChecks,
  monitorDays,
  monitorId,
  monitorSeries,
  monitorUptime,
  month,
  seriesRanges,
} from "@galena/contracts";
import { monthSpan, seriesWindow, windowSpan } from "@galena/core";
import { countMonitorIncidents, monitorIncidentsOverlapping, monitorRepository } from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, notFound, requireRole } from "../http.ts";
import { RECENT_MINUTES } from "../telemetry.ts";
import { json } from "./shared.ts";

/** An incident as a chart marks it. */
const chartIncidentOf = (i: {
  id: IncidentId;
  title: string;
  startedAt: Date;
  resolvedAt: Date | null;
}) => ({
  id: i.id,
  title: i.title,
  startedAt: i.startedAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
});

/** What a monitor's own page reads: its chart, its month, its 90 days and its last hour. */
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
        "`24h` and `7d` give hourly rollups, up to the last whole hour; `30d` and `90d` daily ones, up to yesterday. Each hour is rolled up at five past the next. Median and p95 count answers (up and degraded) only; phases are means, so they add up. `totals` are the whole range per region and then for all regions (`region: null`), from merged histograms; `uptime` is its minutes checked and down; `incidents` are the ones the monitor opened that overlap the range.",
      middleware: [viewer],
      request: {
        params: z.object({ id: monitorId }),
        query: z.object({ range: z.enum(seriesRanges).default("24h") }),
      },
      responses: {
        200: json(monitorSeries, "Points oldest first, then by region; totals; incidents"),
      },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      const { range } = c.req.valid("query");
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      const window = seriesWindow(range, new Date());
      const [{ points, totals }, uptime] = await Promise.all([
        deps.telemetry.series(id, window),
        deps.telemetry.uptime(id, window),
      ]);
      const overlapping = await monitorIncidentsOverlapping(
        db,
        member.workspaceId,
        id,
        windowSpan(window),
      );
      const incidents = overlapping.map(chartIncidentOf);
      const { from, to } = window;
      return c.json(
        {
          range,
          step: window.source,
          from,
          to,
          points,
          totals,
          uptime: { minutes: uptime.minutes, minutesDown: uptime.down },
          incidents,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/{id}/days",
      tags: ["Monitors"],
      summary: "A monitor's last 90 days: minutes checked and minutes down, for its uptime bar",
      description:
        "Oldest first, ending today (UTC). A day counts once rolled up after midnight; today counts its hours so far. A minute is down when a quorum of regions failed it.",
      middleware: [viewer],
      request: { params: z.object({ id: monitorId }) },
      responses: { 200: json(monitorDays, "90 days, oldest first, and their incidents") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      const today = new Date().toISOString().slice(0, 10);
      const days = await deps.telemetry.days(id, today);
      // The first of the 90 days, whatever the rollups hold.
      const from = new Date(Date.parse(`${today}T00:00:00.000Z`) - 89 * 86_400_000);
      const overlapping = await monitorIncidentsOverlapping(db, member.workspaceId, id, {
        from,
        to: new Date(),
      });
      return c.json({ days, incidents: overlapping.map(chartIncidentOf) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/monitors/{id}/checks",
      tags: ["Monitors"],
      summary: "A monitor's last 60 minutes of results, with each failure's error",
      description:
        "Newest first, one entry per region that reported each scheduled minute; none when it hasn't been checked in the last hour.",
      middleware: [viewer],
      request: { params: z.object({ id: monitorId }) },
      responses: { 200: json(monitorChecks, "Results, newest first") },
    }),
    async (c) => {
      const member = c.get("member");
      const { id } = c.req.valid("param");
      if (!(await monitors.findById(member.workspaceId, id))) notFound("Monitor");
      const since = new Date(Date.now() - RECENT_MINUTES * 60_000).toISOString();
      const results = await deps.telemetry.checks(id, since);
      return c.json({ regions: [...deps.telemetry.regions], results }, 200);
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
