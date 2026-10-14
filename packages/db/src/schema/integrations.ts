import { type IntegrationId, type Route, signalOutcomes, signalSources } from "@galena/contracts";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns.ts";
import { publishPolicy } from "./monitors.ts";
import { workspaceRef } from "./workspace.ts";

export const signalSource = pgEnum("signal_source", signalSources);
export const signalOutcome = pgEnum("signal_outcome", signalOutcomes);

const at = () => timestamp({ withTimezone: true });

/**
 * An alert source with its own hook URL. The URL's token is signed, not stored: only when it
 * was made, so making a new one revokes the old.
 */
export const integration = pgTable(
  "integration",
  {
    id: uuid().primaryKey().$type<IntegrationId>(),
    workspaceId: workspaceRef(),
    source: signalSource().notNull(),
    name: text().notNull(),
    publishPolicy: publishPolicy().notNull().default("approve"),
    /** In order: an alert takes the first route it matches. */
    routes: jsonb().$type<Route[]>().notNull().default([]),
    /** Whole seconds, as the token carries it. */
    tokenIssuedAt: at().notNull(),
    lastSignalAt: at(),
    lastOutcome: signalOutcome(),
    ...timestamps,
  },
  (t) => [index().on(t.workspaceId)],
);

/**
 * One alert notification `signal.ingest` acted on, by its idempotency key, so a source repeating
 * it (Alertmanager's `repeat_interval`, hours later) changes nothing.
 */
export const signalReceipt = pgTable(
  "signal_receipt",
  {
    id: uuid().primaryKey(),
    workspaceId: workspaceRef(),
    integrationId: uuid()
      .notNull()
      .references(() => integration.id, { onDelete: "cascade" })
      .$type<IntegrationId>(),
    key: text().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.key), index().on(t.workspaceId), index().on(t.integrationId)],
);
