import {
  EVIDENCE_ALERTS,
  type EventId,
  type EvidenceEntry,
  type EvidenceNotice,
  evidenceEntry,
  type IncidentId,
  type MonitorId,
  type MonitorState,
  type WorkspaceId,
} from "@galena/contracts";
import { and, asc, count, eq, gte, isNotNull, lte, min, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  delivery,
  integration,
  monitorStateChange,
  timelineEvent,
  webhookEndpoint,
} from "../schema/index.ts";

// What the incident page reads besides the incident itself.

// Known limit: an incident's state changes, timeline entries and endpoint deliveries stop at 500
// each, oldest first; page them by time if an incident ever runs longer than that.
const MAX_ROWS = 500;

// The Data API refuses a result over 1 MiB, and alert labels are the only big part of a timeline
// (a note can hold 100 alerts of 64 labels): past this many bytes of labels, notes come without.
const LABEL_BYTES = 400_000;

/** A monitor's confirmed state changes from `from` to `to`, oldest first. */
export async function monitorTransitions(
  db: Db,
  workspaceId: WorkspaceId,
  monitorId: MonitorId,
  span: { from: Date; to: Date },
): Promise<{ from: MonitorState; to: MonitorState; at: string }[]> {
  const rows = await db
    .select({
      from: monitorStateChange.fromState,
      to: monitorStateChange.toState,
      at: monitorStateChange.at,
    })
    .from(monitorStateChange)
    .where(
      and(
        eq(monitorStateChange.workspaceId, workspaceId),
        eq(monitorStateChange.monitorId, monitorId),
        gte(monitorStateChange.at, span.from),
        lte(monitorStateChange.at, span.to),
      ),
    )
    .orderBy(asc(monitorStateChange.at), asc(monitorStateChange.seq))
    .limit(MAX_ROWS);
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

/**
 * Status changes and alert-group notes, oldest first, each note with its first alerts and its
 * integration's name while it exists.
 */
export async function incidentTimeline(
  db: Db,
  workspaceId: WorkspaceId,
  incidentId: IncidentId,
): Promise<EvidenceEntry[]> {
  const alerts = sql`${timelineEvent.data}->'alerts'`;
  const firstAlerts = sql`jsonb_path_query_array(${alerts}, ${sql.raw(`'$[0 to ${EVIDENCE_ALERTS - 1}]'`)})`;
  const labelBytesSoFar = sql`sum(coalesce(octet_length((${firstAlerts})::text), 0)) over (order by ${timelineEvent.occurredAt}, ${timelineEvent.id})`;
  const rows = await db
    .select({
      kind: timelineEvent.kind,
      at: timelineEvent.occurredAt,
      integrationName: integration.name,
      // Expressions decode as the jsonb column does: the Data API returns JSON as text.
      note: sql`${timelineEvent.data} - 'alerts'`.mapWith(timelineEvent.data),
      alerts:
        sql`case when ${labelBytesSoFar} <= ${sql.raw(String(LABEL_BYTES))} then ${firstAlerts} end`.mapWith(
          timelineEvent.data,
        ),
      alertCount: sql`jsonb_array_length(${alerts})`.mapWith(Number),
    })
    .from(timelineEvent)
    .leftJoin(
      integration,
      and(
        eq(integration.workspaceId, workspaceId),
        sql`${integration.id} = (${timelineEvent.data}->>'integrationId')::uuid`,
      ),
    )
    .where(
      and(
        eq(timelineEvent.workspaceId, workspaceId),
        eq(timelineEvent.incidentId, incidentId),
        // Compared as text: the Data API sends parameters as text.
        sql`${timelineEvent.kind}::text in ('status_changed', 'signal')`,
      ),
    )
    .orderBy(asc(timelineEvent.occurredAt), asc(timelineEvent.id))
    .limit(MAX_ROWS);
  // The data was written by this code; a row that doesn't parse is a bug worth failing on.
  return rows.map(({ kind, at, integrationName, note, alerts, alertCount }) =>
    evidenceEntry.parse(
      Object.assign({}, note, {
        kind,
        at: at.toISOString(),
        integrationName,
        alerts: alerts ?? [],
        alertCount,
      }),
    ),
  );
}

const noSends = () => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });

/** Each notice about the incident, oldest first: emails to subscribers counted, endpoints listed. */
export async function incidentNotices(
  db: Db,
  workspaceId: WorkspaceId,
  incidentId: IncidentId,
): Promise<EvidenceNotice[]> {
  const about = and(eq(delivery.workspaceId, workspaceId), eq(delivery.subjectId, incidentId));
  const [emails, endpoints] = await Promise.all([
    db
      .select({
        eventId: delivery.eventId,
        status: delivery.status,
        deliveries: count(),
        at: min(delivery.createdAt),
      })
      .from(delivery)
      .where(and(about, isNotNull(delivery.subscriberId)))
      .groupBy(delivery.eventId, delivery.status)
      .orderBy(asc(delivery.eventId), asc(delivery.status))
      .limit(MAX_ROWS),
    db
      .select({
        eventId: delivery.eventId,
        at: delivery.createdAt,
        id: webhookEndpoint.id,
        name: webhookEndpoint.name,
        kind: webhookEndpoint.kind,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        sentAt: delivery.sentAt,
      })
      .from(delivery)
      .innerJoin(
        webhookEndpoint,
        and(
          eq(webhookEndpoint.id, delivery.endpointId),
          eq(webhookEndpoint.workspaceId, workspaceId),
        ),
      )
      .where(about)
      .orderBy(asc(delivery.createdAt), asc(delivery.id))
      .limit(MAX_ROWS),
  ]);

  const notices = new Map<EventId, EvidenceNotice>();
  /** The event's notice, made on first sight; it keeps the time of its earliest delivery. */
  const noticeFor = (eventId: EventId, at: Date) => {
    const notice = notices.get(eventId) ?? {
      eventId,
      at: at.toISOString(),
      subscribers: noSends(),
      endpoints: [],
    };
    if (at.toISOString() < notice.at) notice.at = at.toISOString();
    notices.set(eventId, notice);
    return notice;
  };
  for (const { eventId, status, deliveries, at } of emails) {
    if (at) noticeFor(eventId, at).subscribers[status] = deliveries;
  }
  for (const { eventId, at, sentAt, ...endpoint } of endpoints) {
    noticeFor(eventId, at).endpoints.push({ ...endpoint, sentAt: sentAt?.toISOString() ?? null });
  }
  // ISO times in one format sort as text.
  return [...notices.values()].toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
