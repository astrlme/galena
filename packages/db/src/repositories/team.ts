import type { InviteId, MemberId, MemberRole, WorkspaceId } from "@galena/contracts";
import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { invite, member, session, user } from "../schema/index.ts";

// The workspace's people: its members and the invites still open.

// Known limit: the team lists its first 1,000 members and invites; no team is near that.
const MAX_ROWS = 1_000;

/** Neither used nor revoked, and still within its 48 hours. */
const isOpen = (now: Date) =>
  and(isNull(invite.acceptedAt), isNull(invite.revokedAt), gt(invite.expiresAt, now));

/** Members, oldest first, and open invites, oldest first. */
export async function listTeam(db: Db, workspaceId: WorkspaceId, now: Date) {
  const [members, invites] = await Promise.all([
    db
      .select({
        id: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.workspaceId, workspaceId))
      .orderBy(asc(member.createdAt), asc(member.id))
      .limit(MAX_ROWS),
    db
      .select({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
        invitedBy: user.name,
      })
      .from(invite)
      .leftJoin(user, eq(user.id, invite.invitedByUserId))
      .where(and(eq(invite.workspaceId, workspaceId), isOpen(now)))
      .orderBy(asc(invite.createdAt), asc(invite.id))
      .limit(MAX_ROWS),
  ]);
  return { members, invites };
}

export async function countOpenInvites(db: Db, workspaceId: WorkspaceId, now: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(invite)
    .where(and(eq(invite.workspaceId, workspaceId), isOpen(now)));
  return row?.n ?? 0;
}

/** The open invite for `email`, if any: a new invite replaces it, so whoever sends one must be allowed to. */
export async function findOpenInvite(db: Db, workspaceId: WorkspaceId, email: string, now: Date) {
  const [row] = await db
    .select({ id: invite.id, role: invite.role })
    .from(invite)
    .where(and(eq(invite.workspaceId, workspaceId), eq(invite.email, email), isOpen(now)))
    .limit(1);
  return row;
}

/**
 * An invite for `email`, replacing one not yet used or revoked for the same address. False when
 * another invite for it was made at the same moment.
 */
export async function createInvite(
  tx: Db,
  value: {
    id: InviteId;
    workspaceId: WorkspaceId;
    email: string;
    role: MemberRole;
    invitedByUserId: string;
    expiresAt: Date;
  },
  now: Date,
) {
  await tx
    .update(invite)
    .set({ revokedAt: now })
    .where(
      and(
        eq(invite.workspaceId, value.workspaceId),
        eq(invite.email, value.email),
        isNull(invite.acceptedAt),
        isNull(invite.revokedAt),
      ),
    );
  const made = await tx
    .insert(invite)
    .values({ ...value, createdAt: now })
    .onConflictDoNothing({
      target: [invite.workspaceId, invite.email],
      where: sql`${invite.acceptedAt} is null and ${invite.revokedAt} is null`,
    })
    .returning({ id: invite.id });
  return made.length > 0;
}

/** An invite with whoever sent it, by name (null once they've left). */
export async function findInvite(db: Db, id: InviteId) {
  const [row] = await db
    .select({
      id: invite.id,
      workspaceId: invite.workspaceId,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
      invitedBy: user.name,
    })
    .from(invite)
    .leftJoin(user, eq(user.id, invite.invitedByUserId))
    .where(eq(invite.id, id))
    .limit(1);
  return row;
}

/** Whether `email` holds an open invite: the one way to make an account after setup. */
export async function hasOpenInvite(db: Db, email: string, now: Date) {
  const [row] = await db
    .select({ id: invite.id })
    .from(invite)
    .where(and(eq(invite.email, email.toLowerCase()), isOpen(now)))
    .limit(1);
  return row !== undefined;
}

/** The account that signs in with `email`, matched without regard to case. */
export async function findUserByEmail(db: Db, email: string) {
  const [row] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return row;
}

/**
 * Uses the invite and makes `userId` a member with its role, once: a second claim, an expired or
 * revoked invite, or someone already on the team gets undefined and changes nothing.
 */
export async function claimInvite(
  tx: Db,
  input: { inviteId: InviteId; userId: string; memberId: MemberId; now: Date },
): Promise<{ workspaceId: WorkspaceId; role: MemberRole } | undefined> {
  const [claimed] = await tx
    .update(invite)
    .set({ acceptedAt: input.now })
    .where(and(eq(invite.id, input.inviteId), isOpen(input.now)))
    .returning({ workspaceId: invite.workspaceId, role: invite.role });
  if (!claimed) return undefined;
  const [joined] = await tx
    .insert(member)
    .values({
      id: input.memberId,
      workspaceId: claimed.workspaceId,
      userId: input.userId,
      role: claimed.role,
    })
    .onConflictDoNothing({ target: [member.workspaceId, member.userId] })
    .returning({ id: member.id });
  return joined ? claimed : undefined;
}

export async function revokeInvite(tx: Db, workspaceId: WorkspaceId, id: InviteId, now: Date) {
  const revoked = await tx
    .update(invite)
    .set({ revokedAt: now })
    .where(and(eq(invite.workspaceId, workspaceId), eq(invite.id, id), isOpen(now)))
    .returning({ id: invite.id });
  return revoked.length > 0;
}

/**
 * Every member, locked until the transaction ends: two owners changing each other at once take
 * turns, so neither can leave the workspace without one.
 */
export async function lockTeam(tx: Db, workspaceId: WorkspaceId) {
  return tx
    .select({ id: member.id, userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.workspaceId, workspaceId))
    .orderBy(asc(member.id))
    .limit(MAX_ROWS)
    .for("update");
}

export async function setMemberRole(tx: Db, id: MemberId, role: MemberRole) {
  await tx.update(member).set({ role }).where(eq(member.id, id));
}

/** Takes the member off the team and signs them out everywhere; their API keys go with them. */
export async function removeMember(tx: Db, id: MemberId, userId: string) {
  await tx.delete(member).where(eq(member.id, id));
  await tx.delete(session).where(eq(session.userId, userId));
}
