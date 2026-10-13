import { type IntegrationId, type Route, signalOutcomes, signalSources } from "@galena/contracts";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
