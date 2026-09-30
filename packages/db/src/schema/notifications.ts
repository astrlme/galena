import {
  type ComponentId,
  channelKinds,
  type DeliveryId,
  deliveryStatuses,
  type EventId,
  endpointKinds,
  endpointStates,
  type SubscriberId,
  subscriberStates,
  type WebhookEndpointId,
} from "@galena/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { workspaceRef } from "./workspace.ts";

export const subscriberState = pgEnum("subscriber_state", subscriberStates);
export const endpointKind = pgEnum("endpoint_kind", endpointKinds);
export const endpointState = pgEnum("endpoint_state", endpointStates);
export const channelKind = pgEnum("channel_kind", channelKinds);
export const deliveryStatus = pgEnum("delivery_status", deliveryStatuses);

const at = () => timestamp({ withTimezone: true });
/** Components a target follows; empty means every component. */
const followed = () => jsonb().$type<ComponentId[]>().notNull().default([]);

/** Someone who signed up by email on the status page (double opt-in). */
export const subscriber = pgTable(
  "subscriber",
  {
    id: uuid().primaryKey().$type<SubscriberId>(),
    workspaceId: workspaceRef(),
    /** Lower-cased. Never logged: logs carry a hash. */
    email: text().notNull(),
    state: subscriberState().notNull().default("pending_confirmation"),
    componentIds: followed(),
    confirmSentAt: at(),
    confirmedAt: at(),
    /** Keyed hash of the address that asked, for the per-IP limit on the form. */
    ipHash: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.workspaceId, t.email),
    index().on(t.workspaceId, t.state),
    index().on(t.ipHash, t.createdAt),
  ],
);

/** A Slack incoming webhook or a signed outgoing webhook a member added. */
export const webhookEndpoint = pgTable(
  "webhook_endpoint",
  {
    id: uuid().primaryKey().$type<WebhookEndpointId>(),
    workspaceId: workspaceRef(),
    kind: endpointKind().notNull(),
    name: text().notNull(),
    /** The URL, sealed with the app key: Slack's carries its credential in the path. */
    urlSealed: text().notNull(),
    /** Outgoing webhooks' signing secret, sealed. */
    secretSealed: text(),
    state: endpointState().notNull().default("active"),
    componentIds: followed(),
    failingSince: at(),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId)],
);

/**
 * Telling one target about one event. Unique per (event, target), so a re-run finds the row
 * instead of sending again.
 */
export const delivery = pgTable(
  "delivery",
  {
    id: uuid().primaryKey().$type<DeliveryId>(),
    workspaceId: workspaceRef(),
    /** The event envelope's id. */
    eventId: uuid().notNull().$type<EventId>(),
    /** The incident or maintenance window the event is about. */
    subjectId: uuid().notNull(),
    subscriberId: uuid()
      .$type<SubscriberId>()
      .references(() => subscriber.id, { onDelete: "cascade" }),
    endpointId: uuid()
      .$type<WebhookEndpointId>()
      .references(() => webhookEndpoint.id, { onDelete: "cascade" }),
    channel: channelKind().notNull(),
    status: deliveryStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text(),
    /** SES's message id, for matching bounces and complaints. */
    providerId: text(),
    sentAt: at(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.eventId, t.subscriberId),
    uniqueIndex().on(t.eventId, t.endpointId),
    index().on(t.subscriberId),
    index().on(t.endpointId),
    index().on(t.workspaceId, t.subjectId),
    check("delivery_one_target", sql`(${t.subscriberId} is null) <> (${t.endpointId} is null)`),
  ],
);
