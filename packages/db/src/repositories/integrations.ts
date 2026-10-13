import type {
  IntegrationId,
  PublishPolicy,
  Route,
  SignalOutcome,
  SignalSource,
  WorkspaceId,
} from "@galena/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { integration } from "../schema/index.ts";

export type IntegrationRow = {
  id: IntegrationId;
  workspaceId: WorkspaceId;
  source: SignalSource;
  name: string;
  publishPolicy: PublishPolicy;
  routes: Route[];
  tokenIssuedAt: Date;
  lastSignalAt: Date | null;
  lastOutcome: SignalOutcome | null;
  createdAt: Date;
};

const columns = {
  id: integration.id,
  workspaceId: integration.workspaceId,
  source: integration.source,
  name: integration.name,
  publishPolicy: integration.publishPolicy,
  routes: integration.routes,
  tokenIssuedAt: integration.tokenIssuedAt,
  lastSignalAt: integration.lastSignalAt,
  lastOutcome: integration.lastOutcome,
  createdAt: integration.createdAt,
};

// Known limit: a deployment lists its first 100 integrations; one alert source rarely needs many.
const MAX_INTEGRATIONS = 100;

const scoped = (workspaceId: WorkspaceId, id: IntegrationId) =>
  and(eq(integration.workspaceId, workspaceId), eq(integration.id, id));

export async function listIntegrations(
  db: Db,
  workspaceId: WorkspaceId,
): Promise<IntegrationRow[]> {
  return db
    .select(columns)
    .from(integration)
    .where(eq(integration.workspaceId, workspaceId))
    .orderBy(asc(integration.createdAt), asc(integration.id))
    .limit(MAX_INTEGRATIONS);
}

/** By id alone: the hook URL carries the id, signed. */
export async function findIntegration(
  db: Db,
  id: IntegrationId,
): Promise<IntegrationRow | undefined> {
  const [row] = await db.select(columns).from(integration).where(eq(integration.id, id));
  return row;
}

export async function createIntegration(
  db: Db,
  row: Omit<IntegrationRow, "lastSignalAt" | "lastOutcome" | "createdAt">,
): Promise<void> {
  await db.insert(integration).values(row);
}

/** False when there is no such integration. */
export async function updateIntegration(
  db: Db,
  workspaceId: WorkspaceId,
  id: IntegrationId,
  fields: Pick<IntegrationRow, "name" | "publishPolicy" | "routes">,
): Promise<boolean> {
  const rows = await db
    .update(integration)
    .set(fields)
    .where(scoped(workspaceId, id))
    .returning({ id: integration.id });
  return rows.length > 0;
}

/** A new hook URL: alerts sent to the old one are dropped from now on. */
export async function setIntegrationToken(
  db: Db,
  workspaceId: WorkspaceId,
  id: IntegrationId,
  tokenIssuedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(integration)
    .set({ tokenIssuedAt })
    .where(scoped(workspaceId, id))
    .returning({ id: integration.id });
  return rows.length > 0;
}

export async function deleteIntegration(
  db: Db,
  workspaceId: WorkspaceId,
  id: IntegrationId,
): Promise<boolean> {
  const rows = await db
    .delete(integration)
    .where(scoped(workspaceId, id))
    .returning({ id: integration.id });
  return rows.length > 0;
}

/** What the latest alert group did, for the dashboard. */
export async function recordSignalOutcome(
  db: Db,
  id: IntegrationId,
  outcome: SignalOutcome,
  at: Date,
): Promise<void> {
  await db
    .update(integration)
    .set({ lastSignalAt: at, lastOutcome: outcome })
    .where(eq(integration.id, id));
}
