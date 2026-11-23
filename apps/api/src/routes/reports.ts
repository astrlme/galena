import { month, uptimeReport } from "@galena/contracts";
import {
  componentMinutes,
  errorBudget,
  type MonthOf,
  minutesLeftIn,
  monthSpan,
} from "@galena/core";
import {
  componentRepository,
  listUptimeDays,
  monitorRepository,
  monthIncidentCounts,
} from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, requireRole } from "../http.ts";
import { json } from "./shared.ts";

/** Monitors whose month is read from telemetry at once: each is up to four queries. */
const AT_ONCE = 10;

export function registerReportRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const viewer = requireRole(deps, "viewer");

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/reports/uptime",
      tags: ["Reports"],
      summary: "Every monitor's and component's month: uptime, incidents, p95 and error budget",
      description:
        "The month defaults to the current one (UTC). A monitor's minute is down when a quorum of regions failed it; each hour counts once rolled up, at five past the next, and days are kept 400 days. A component counts the minutes its status page showed, partial and major outages as down. Maintenance is not taken out of either. A monitor's error budget is its SLA target's share of the minutes checked plus the minutes still to come this month, less the minutes down.",
      middleware: [viewer],
      request: { query: z.object({ month: month.optional() }) },
      responses: {
        200: json(uptimeReport, "Monitors in creation order, components in page order"),
      },
    }),
    async (c) => {
      const { workspaceId } = c.get("member");
      const now = new Date();
      const asked = c.req.valid("query").month ?? now.toISOString().slice(0, 7);
      const span = monthSpan(asked);
      const [monitors, components, incidents, days] = await Promise.all([
        monitorRepository(db).listByWorkspace(workspaceId),
        componentRepository(db).listByWorkspace(workspaceId),
        monthIncidentCounts(db, workspaceId, span),
        listUptimeDays(db, workspaceId, span.days.from, span.days.to),
      ]);
      // Known limit: a month reads about 100 small items per monitor (a day in each region);
      // past a few hundred monitors, a monthly rollup item would cut that to three.
      // In the monitors' order.
      const months: MonthOf[] = [];
      const today = now.toISOString().slice(0, 10);
      for (let i = 0; i < monitors.length; i += AT_ONCE) {
        const batch = monitors.slice(i, i + AT_ONCE);
        months.push(
          ...(await Promise.all(batch.map((m) => deps.telemetry.month(m.id, asked, today)))),
        );
      }
      const left = minutesLeftIn(asked, now);
      const daysOf = Map.groupBy(days, (d) => d.componentId);
      return c.json(
        {
          month: asked,
          monitors: monitors.map((m, i) => {
            const counted = months[i] ?? { minutes: 0, minutesDown: 0, p95Ms: null };
            const { minutes, minutesDown } = counted;
            return {
              id: m.id,
              name: m.name,
              type: m.type,
              ...counted,
              incidents: incidents.monitors.get(m.id) ?? 0,
              slaTarget: m.slaTarget,
              budget:
                m.slaTarget === null
                  ? null
                  : errorBudget({ minutes, down: minutesDown }, m.slaTarget, left),
            };
          }),
          components: components.map((component) => {
            const { minutes, down } = componentMinutes(
              (daysOf.get(component.id) ?? []).map((d) => d.minutes),
            );
            return {
              id: component.id,
              name: component.name,
              minutes: Math.round(minutes),
              minutesDown: down,
              incidents: incidents.components.get(component.id) ?? 0,
            };
          }),
        },
        200,
      );
    },
  );
}
