import { month, uptimeReport as uptimeReportSchema } from "@galena/contracts";
import { monthSpan, type ReportInputs, uptimeReport } from "@galena/core";
import {
  componentRepository,
  listUptimeDays,
  monitorRepository,
  monthIncidentCounts,
} from "@galena/db";
import { createRoute, z } from "@hono/zod-openapi";
import { type App, type Deps, requireRole } from "../http.ts";
import { json } from "./shared.ts";

/** Monitors whose month is read from telemetry at once: each is two to six queries. */
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
        200: json(uptimeReportSchema, "Monitors in creation order, components in page order"),
      },
    }),
    async (c) => {
      const { workspaceId } = c.get("member");
      const now = new Date();
      const month = c.req.valid("query").month ?? now.toISOString().slice(0, 7);
      const span = monthSpan(month);
      const [monitors, components, incidents, days] = await Promise.all([
        monitorRepository(db).listByWorkspace(workspaceId),
        componentRepository(db).listByWorkspace(workspaceId),
        monthIncidentCounts(db, workspaceId, span),
        listUptimeDays(db, workspaceId, span.days.from, span.days.to),
      ]);
      // Known limit: each monitor's month reads a minutes item and an item per region for every
      // day, each region item holding a latency histogram, so a long list spends much of the
      // telemetry table's burst capacity; a monthly item written by the rollup would cut it to a
      // few. A deleted monitor leaves every month's report, though its items and incidents stay.
      const today = now.toISOString().slice(0, 10);
      const counted: ReportInputs["monitors"][number][] = [];
      for (let i = 0; i < monitors.length; i += AT_ONCE) {
        const batch = monitors.slice(i, i + AT_ONCE);
        counted.push(
          ...(await Promise.all(
            batch.map(async (m) => ({
              ...m,
              counted: await deps.telemetry.month(m.id, month, today),
            })),
          )),
        );
      }
      return c.json(
        uptimeReport({ month, monitors: counted, components, days, incidents }, now),
        200,
      );
    },
  );
}
