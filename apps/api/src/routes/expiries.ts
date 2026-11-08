import { expiryList } from "@galena/contracts";
import { monitorRepository } from "@galena/db";
import { createRoute } from "@hono/zod-openapi";
import { type App, type Deps, requireRole } from "../http.ts";
import { json } from "./shared.ts";

// Certificates and domains the hourly expiry scan watches, read from DynamoDB in one query.

/** ISO times in one format sort as text; an unknown expiry goes last. */
const soonest = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

export function registerExpiryRoutes(app: App, deps: Deps) {
  const viewer = requireRole(deps, "viewer");
  const monitors = monitorRepository(deps.db);

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/expiries",
      tags: ["Monitors"],
      summary: "Certificates and domains that expire",
      description:
        "Each TLS certificate (by host) and registered domain the workspace's HTTP monitors reach, soonest expiry first; a domain whose registry publishes no expiry date comes last. Checked every hour, domains once a day.",
      middleware: [viewer],
      responses: { 200: json(expiryList, "Expiries") },
    }),
    async (c) => {
      const { workspaceId } = c.get("member");
      const [all, own] = await Promise.all([
        deps.telemetry.expiries(workspaceId),
        monitors.listByWorkspace(workspaceId),
      ]);
      // The scan runs hourly: a monitor deleted since then drops out here at once.
      const ids = new Set(own.map((m) => m.id));
      const expiries = all
        .map((e) => ({ ...e, monitorIds: e.monitorIds.filter((id) => ids.has(id)) }))
        .filter((e) => e.monitorIds.length > 0)
        .toSorted((a, b) => soonest(a.expiresAt, b.expiresAt));
      return c.json({ expiries }, 200);
    },
  );
}
