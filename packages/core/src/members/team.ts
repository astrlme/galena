import type { MemberRole } from "@galena/contracts";
import { err, ok, type Result } from "../result.ts";
import { roleAtLeast } from "../roles.ts";

export type TeamChangeError = "not_allowed" | "last_owner";

/**
 * Whether `actor` may move someone from `from` (null: not on the team yet, an invite) to `to`.
 * Admins and owners manage the team; anything that makes, changes or removes an owner needs an
 * owner; and the last owner stays one, so the workspace never loses its way in.
 */
export function checkTeamChange(input: {
  actor: MemberRole;
  from: MemberRole | null;
  to: MemberRole | "removed";
  /** Owners on the team now. */
  owners: number;
}): Result<null, TeamChangeError> {
  const { actor, from, to, owners } = input;
  if (!roleAtLeast(actor, "admin")) {
    return err("not_allowed", "Only admins and owners manage the team.");
  }
  if ((from === "owner" || to === "owner") && actor !== "owner") {
    return err("not_allowed", "Only an owner can make, change or remove an owner.");
  }
  if (from === "owner" && to !== "owner" && owners <= 1) {
    return err("last_owner", "A workspace needs an owner. Make someone else an owner first.");
  }
  return ok(null);
}

/** Whether `actor` may invite someone as `role`, or act on an invite for it: owners only from an owner. */
export function checkInvite(actor: MemberRole, role: MemberRole): Result<null, TeamChangeError> {
  // An invite takes no one off the team, so how many owners there are doesn't matter.
  return checkTeamChange({ actor, from: null, to: role, owners: 1 });
}

export type InviteState = "open" | "used" | "revoked" | "expired";

/** Where an invite stands at `now`: only an open one can be accepted, emailed or cancelled. */
export function inviteState(
  invite: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): InviteState {
  if (invite.acceptedAt) return "used";
  if (invite.revokedAt) return "revoked";
  return invite.expiresAt.getTime() <= now.getTime() ? "expired" : "open";
}
