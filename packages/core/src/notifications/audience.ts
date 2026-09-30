import type {
  ComponentId,
  EventId,
  IncidentEventType,
  IncidentVisibility,
  MaintenanceEventType,
  Notice,
  NoticeKind,
} from "@galena/contracts";
import type { Incident, IncidentUpdate, Maintenance } from "../ports.ts";

// Who hears about an incident or maintenance event, and what they are told.

export type NotifyEvent =
  | { type: IncidentEventType; visibility: IncidentVisibility }
  | { type: MaintenanceEventType; version: number };

/**
 * Incidents only while published: drafts, dismissed and internal ones never reach anyone.
 * Maintenance when it is first scheduled (not on every edit), starts, completes or is cancelled.
 */
export function notifies(event: NotifyEvent): boolean {
  if ("visibility" in event) return event.visibility === "published";
  return event.type !== "maintenance.scheduled" || event.version === 1;
}

/** Targets that follow any of the event's components; an event naming none reaches everyone. */
export function audience<T extends { componentIds: readonly ComponentId[] }>(
  eventComponents: readonly ComponentId[],
  targets: readonly T[],
): T[] {
  if (eventComponents.length === 0) return [...targets];
  return targets.filter(
    (t) => t.componentIds.length === 0 || t.componentIds.some((id) => eventComponents.includes(id)),
  );
}

/** An update to an incident nobody was told about yet (a draft just published) is news. */
export function noticeKind(
  type: IncidentEventType | MaintenanceEventType,
  alreadyAnnounced: boolean,
): NoticeKind {
  if (type === "incident.updated" && !alreadyAnnounced) return "incident_created";
  return type.replace(".", "_") as NoticeKind;
}

type NoticeInput = {
  eventId: EventId;
  kind: NoticeKind;
  /** Component names by id; a component deleted since drops out. */
  names: ReadonlyMap<ComponentId, string>;
  page: Notice["page"];
  occurredAt: Date;
};

export function incidentNotice(
  input: NoticeInput & { incident: Incident & { updates: IncidentUpdate[] } },
): Notice {
  const { incident } = input;
  return {
    kind: input.kind,
    eventId: input.eventId,
    page: input.page,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    components: incident.components.flatMap(({ componentId: id, status }) => {
      const name = input.names.get(id);
      return name === undefined ? [] : [{ id, name, status }];
    }),
    // Updates come newest first.
    body: incident.updates[0]?.body ?? "",
    startsAt: incident.startedAt.toISOString(),
    endsAt: incident.resolvedAt?.toISOString() ?? null,
    occurredAt: input.occurredAt.toISOString(),
    url: `${input.page.url}/incidents/${incident.id}/`,
  };
}

export function maintenanceNotice(input: NoticeInput & { window: Maintenance }): Notice {
  const { window } = input;
  return {
    kind: input.kind,
    eventId: input.eventId,
    page: input.page,
    title: window.title,
    status: window.status,
    impact: null,
    components: window.componentIds.flatMap((id) => {
      const name = input.names.get(id);
      return name === undefined ? [] : [{ id, name, status: null }];
    }),
    body: window.body,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    occurredAt: input.occurredAt.toISOString(),
    url: `${input.page.url}/`,
  };
}
