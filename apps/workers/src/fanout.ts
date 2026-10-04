import {
  type EndpointKind,
  eventId,
  incidentEventData,
  incidentEventTypes,
  maintenanceEventData,
  maintenanceEventTypes,
  type Notice,
  type SubscriberId,
  type WebhookEndpointId,
  workspaceId,
} from "@galena/contracts";
import { audience, incidentNotice, maintenanceNotice, noticeKind, notifies } from "@galena/core";
import {
  componentRepository,
  type Db,
  ensurePage,
  incidentRepository,
  listActiveSubscribers,
  listDeliverableEndpoints,
  maintenanceRepository,
  recordDeliveries,
  wasAnnounced,
} from "@galena/db";
import { z } from "zod";

// The outbox events that can reach subscribers, as the dispatcher hands over their envelopes.
const envelope = { id: eventId, workspaceId, occurredAt: z.iso.datetime() };
const incidentEvent = z.object({
  ...envelope,
  type: z.enum(incidentEventTypes),
  data: incidentEventData,
});
const maintenanceEvent = z.object({
  ...envelope,
  type: z.enum(maintenanceEventTypes),
  data: maintenanceEventData,
});
export const fanoutPayload = z.union([incidentEvent, maintenanceEvent]);
export type FanoutEvent = z.infer<typeof fanoutPayload>;

const isIncident = (e: FanoutEvent): e is z.infer<typeof incidentEvent> =>
  incidentEvent.shape.type.safeParse(e.type).success;

export const isNotifyEvent = (type: string) =>
  incidentEvent.shape.type.safeParse(type).success ||
  maintenanceEvent.shape.type.safeParse(type).success;

export type FanoutDeps = {
  db: Db;
  url: string;
  /** Starts one `notify.email` per subscriber, keyed `send:{eventId}:{subscriberId}`. */
  sendEmails: (
    requests: ReadonlyArray<{ subscriberId: SubscriberId; notice: Notice }>,
  ) => Promise<void>;
  /** Starts one `notify.slack` or `notify.webhook` per endpoint, `send:{eventId}:{endpointId}`. */
  sendToEndpoints: (
    requests: ReadonlyArray<{ endpointId: WebhookEndpointId; kind: EndpointKind; notice: Notice }>,
  ) => Promise<void>;
};
export type FanoutOutcome = "not_notified" | "gone" | "no_page" | "fanned_out";

/**
 * Tells everyone who follows the event's components. Deliveries are recorded before the sends
 * start and are unique per (event, target), so running this again sends nothing twice.
 */
export async function fanOut(
  event: FanoutEvent,
  deps: FanoutDeps,
): Promise<{ outcome: FanoutOutcome; targets?: number }> {
  if (
    !notifies(
      isIncident(event)
        ? { type: event.type, visibility: event.data.visibility }
        : { type: event.type, version: event.data.version },
    )
  ) {
    return { outcome: "not_notified" };
  }
  const target = await ensurePage(deps.db);
  if (!target) return { outcome: "no_page" };
  const ws = event.workspaceId;
  const names = new Map(
    (await componentRepository(deps.db).listByWorkspace(ws)).map((c) => [c.id, c.name]),
  );
  const common = {
    eventId: event.id,
    names,
    page: { name: target.name, url: deps.url },
    occurredAt: new Date(event.occurredAt),
  };

  let notice: Notice;
  let subjectId: string;
  if (isIncident(event)) {
    const incident = await incidentRepository(deps.db).findById(ws, event.data.incidentId);
    // Made internal or dismissed since, or deleted: nobody hears about it any more.
    if (incident?.visibility !== "published") return { outcome: "gone" };
    subjectId = incident.id;
    const announced = await wasAnnounced(deps.db, ws, subjectId, event.id);
    notice = incidentNotice({
      ...common,
      kind: noticeKind(event.type, announced),
      incident,
      updateId: event.data.updateId,
    });
  } else {
    const window = await maintenanceRepository(deps.db).findById(ws, event.data.maintenanceId);
    if (!window) return { outcome: "gone" };
    subjectId = window.id;
    notice = maintenanceNotice({ ...common, kind: noticeKind(event.type, true), window });
  }

  const components = notice.components.map((c) => c.id);
  const subscribers = audience(components, await listActiveSubscribers(deps.db, ws));
  const endpoints = audience(components, await listDeliverableEndpoints(deps.db, ws));
  await recordDeliveries(deps.db, { workspaceId: ws, eventId: event.id, subjectId }, [
    ...subscribers.map((s) => ({ subscriberId: s.id, channel: "email" as const })),
    ...endpoints.map((e) => ({ endpointId: e.id, channel: e.kind })),
  ]);
  await deps.sendEmails(subscribers.map((s) => ({ subscriberId: s.id, notice })));
  await deps.sendToEndpoints(endpoints.map((e) => ({ endpointId: e.id, kind: e.kind, notice })));
  return { outcome: "fanned_out", targets: subscribers.length + endpoints.length };
}
