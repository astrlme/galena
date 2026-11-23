import type { ComponentId, MonitorId, WorkspaceId } from "@galena/contracts";
import { monitorOfIncident } from "@galena/core";
import { and, count, countDistinct, eq, gte, isNull, like, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { incident, incidentComponent } from "../schema/index.ts";
import { countedIncidents } from "./incidents.ts";

/**
 * The incidents that started in `span`, counted two ways in two queries: by the monitor that
 * opened them, as on the monitor's own page, and by component, published ones only, as the status
 * page shows them.
 */
export async function monthIncidentCounts(
  db: Db,
  workspaceId: WorkspaceId,
  span: { from: Date; to: Date },
): Promise<{ monitors: Map<MonitorId, number>; components: Map<ComponentId, number> }> {
  const started = [gte(incident.startedAt, span.from), lt(incident.startedAt, span.to)];
  const [byKey, byComponent] = await Promise.all([
    db
      .select({ key: incident.dedupKey, n: count() })
      .from(incident)
      .where(and(...countedIncidents(workspaceId), ...started, like(incident.dedupKey, "mon:%")))
      .groupBy(incident.dedupKey),
    db
      .select({ id: incidentComponent.componentId, n: countDistinct(incident.id) })
      .from(incidentComponent)
      .innerJoin(incident, eq(incident.id, incidentComponent.incidentId))
      .where(
        and(
          eq(incident.workspaceId, workspaceId),
          isNull(incident.deletedAt),
          ...started,
          sql`${incident.visibility}::text = 'published'`,
        ),
      )
      .groupBy(incidentComponent.componentId),
  ]);
  const monitors = new Map<MonitorId, number>();
  for (const { key, n } of byKey) {
    const id = monitorOfIncident(key);
    if (id) monitors.set(id, n);
  }
  return { monitors, components: new Map(byComponent.map((r) => [r.id, r.n])) };
}
