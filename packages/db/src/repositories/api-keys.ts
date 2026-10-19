import type { ApiKeyId, ApiKeyScope, WorkspaceId } from "@galena/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { apiKey, member, user } from "../schema/index.ts";

/** The keys of a workspace, newest first: never their hashes. Known limit: the first 100. */
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
    .orderBy(desc(apiKey.createdAt), desc(apiKey.id))
    .limit(100);
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
): Promise<Date> {
  const [stored] = await db.insert(apiKey).values(row).returning({ createdAt: apiKey.createdAt });
  if (!stored) throw new Error("The API key wasn't stored.");
  return stored.createdAt;
}

export async function deleteApiKey(db: Db, workspaceId: WorkspaceId, id: ApiKeyId) {
  await db.delete(apiKey).where(and(eq(apiKey.workspaceId, workspaceId), eq(apiKey.id, id)));
}

/**
 * Who a presented key acts as: its maker, with their role in the key's workspace (a key goes
 * with its maker's membership). Looked up by the key's hash, never by the key itself.
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
