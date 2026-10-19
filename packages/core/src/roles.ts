import { type ApiKeyScope, type MemberRole, memberRoles } from "@galena/contracts";

/** Whether `actual` grants at least what `required` does (owner > admin > editor > viewer). */
export function roleAtLeast(actual: MemberRole, required: MemberRole): boolean {
  return memberRoles.indexOf(actual) <= memberRoles.indexOf(required);
}

const SCOPE_ROLE: Record<ApiKeyScope, MemberRole> = {
  read: "viewer",
  write: "editor",
  admin: "admin",
};

/**
 * The role an API key acts with: its scope's, but never more than the member who made it has
 * now, so a member's keys lose what the member loses.
 */
export function keyRole(scope: ApiKeyScope, creator: MemberRole): MemberRole {
  const role = SCOPE_ROLE[scope];
  return roleAtLeast(creator, role) ? role : creator;
}
