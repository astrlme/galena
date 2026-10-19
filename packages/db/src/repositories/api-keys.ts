import type { ApiKeyId, ApiKeyScope, WorkspaceId } from "@galena/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { apiKey, member, user } from "../schema/index.ts";

/** The keys of a workspace, newest first: never their hashes. */
export function listApiKeys(db: Db, workspaceId: WorkspaceId) {
  return db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      scope: apiKey.scope,
      prefix: apiKey.prefix,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.workspaceId, workspaceId))
    .orderBy(desc(apiKey.createdAt), desc(apiKey.id));
}

export async function createApiKey(
  db: Db,
  row: {
    id: ApiKeyId;
    workspaceId: WorkspaceId;
    name: string;
    scope: ApiKeyScope;
    prefix: string;
    hash: string;
    createdByUserId: string;
  },
): Promise<void> {
  await db.insert(apiKey).values(row);
}

export async function deleteApiKey(
  db: Db,
  workspaceId: WorkspaceId,
  id: ApiKeyId,
): Promise<boolean> {
  const rows = await db
    .delete(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, id)))
    .returning({ id: apiKey.id });
  return rows.length === 1;
}

/**
 * Who a presented key acts as: its maker, while they are still a member of the key's workspace.
 * Looked up by the key's hash, so the key itself is never compared or stored.
 */
export async function findApiKeyActor(db: Db, hash: string) {
  const [row] = await db
    .select({
      keyId: apiKey.id,
      scope: apiKey.scope,
      workspaceId: apiKey.workspaceId,
      userId: apiKey.createdByUserId,
      email: user.email,
      role: member.role,
    })
    .from(apiKey)
    .innerJoin(
      member,
      and(eq(member.userId, apiKey.createdByUserId), eq(member.workspaceId, apiKey.workspaceId)),
    )
    .innerJoin(user, eq(user.id, apiKey.createdByUserId))
    .where(eq(apiKey.hash, hash))
    .limit(1);
  return row;
}
