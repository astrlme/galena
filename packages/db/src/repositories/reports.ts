import type { ComponentId, MonitorId, WorkspaceId } from "@galena/contracts";
import { and, count, countDistinct, eq, gte, isNull, like, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { incident, incidentComponent } from "../schema/index.ts";

const MONITOR_KEY = "mon:";

/**
 * The incidents that started in `span`, counted two ways in two queries: by the monitor that
 * opened them (drafts and internal ones too, as on the monitor's own page; never dismissed or
 * deleted), and by component, published ones only, as the status page shows them.
 */
export async function monthIncidentCounts(
  db: Db,
  workspaceId: WorkspaceId,
  span: { from: Date; to: Date },
): Promise<{ monitors: Map<MonitorId, number>; components: Map<ComponentId, number> }> {
  const started = [
    eq(incident.workspaceId, workspaceId),
    isNull(incident.deletedAt),
    gte(incident.startedAt, span.from),
    lt(incident.startedAt, span.to),
  ];
  const [byMonitor, byComponent] = await Promise.all([
    db
      .select({ key: incident.dedupKey, n: count() })
      .from(incident)
      .where(
        and(
          ...started,
          like(incident.dedupKey, `${MONITOR_KEY}%`),
          sql`${incident.visibility}::text <> 'dismissed'`,
        ),
      )
      .groupBy(incident.dedupKey),
    db
      .select({ id: incidentComponent.componentId, n: countDistinct(incident.id) })
      .from(incidentComponent)
      .innerJoin(incident, eq(incident.id, incidentComponent.incidentId))
      .where(and(...started, sql`${incident.visibility}::text = 'published'`))
      .groupBy(incidentComponent.componentId),
  ]);
  return {
    monitors: new Map(
      byMonitor.map((r) => [String(r.key).slice(MONITOR_KEY.length) as MonitorId, r.n]),
    ),
    components: new Map(byComponent.map((r) => [r.id, r.n])),
  };
}
