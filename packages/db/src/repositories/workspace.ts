import type { MemberId, MemberRole, WorkspaceId } from "@galena/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { member, user, workspace } from "../schema/index.ts";

/** Whether first-run setup has happened (one workspace per deployment). */
export async function workspaceExists(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: workspace.id }).from(workspace).limit(1);
  return row !== undefined;
}

/** The user's role and workspace, or undefined when they are not a member. */
export async function findMembership(
  db: Db,
  userId: string,
): Promise<{ role: MemberRole; workspaceId: WorkspaceId } | undefined> {
  const [row] = await db
    .select({ role: member.role, workspaceId: member.workspaceId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  return row;
}

/** The member of `workspaceId` who signs in with `email`, matched without regard to case. */
export async function findMemberByEmail(
  db: Db,
  workspaceId: WorkspaceId,
  email: string,
): Promise<{ userId: string; role: MemberRole } | undefined> {
  const [row] = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(eq(member.workspaceId, workspaceId), sql`lower(${user.email}) = ${email.toLowerCase()}`),
    )
    .limit(1);
  return row;
}

// Any constant works, as long as every first-run setup uses the same one.
const SETUP_LOCK = 71_356_229;

/**
 * Creates the workspace and its owner's membership, unless a workspace already exists
 * (one per deployment). Concurrent setups queue on an advisory lock that ends
 * with the transaction, so only the first creates anything.
 */
export async function createWorkspace(
  db: Db,
  input: { id: WorkspaceId; name: string; owner: { memberId: MemberId; userId: string } },
): Promise<"created" | "exists"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    const [existing] = await tx.select({ id: workspace.id }).from(workspace).limit(1);
    if (existing) return "exists";
    await tx.insert(workspace).values({ id: input.id, name: input.name });
    await tx.insert(member).values({
      id: input.owner.memberId,
      workspaceId: input.id,
      userId: input.owner.userId,
      role: "owner",
    });
    return "created";
  });
}
