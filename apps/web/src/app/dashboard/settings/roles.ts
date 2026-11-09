import { type MemberRole, memberRoles } from "@galena/contracts";
import { memberRoleLabels, memberRoleSummaries } from "@galena/contracts/copy";
import { checkInvite } from "@galena/core";

// Roles as the team's forms offer them.

/** "Sees everything" → "sees everything": only the first letter, so "API keys" keeps its case. */
const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** "Viewer: sees everything and changes nothing." for a role select. */
export const roleOptions = (roles: readonly MemberRole[]) =>
  roles.map((value) => ({
    value,
    label: `${memberRoleLabels[value]}: ${lowerFirst(memberRoleSummaries[value])}`,
  }));

/** The roles `actor` may give someone: an owner only from an owner. */
export const grantable = (actor: MemberRole) =>
  memberRoles.filter((to) => checkInvite(actor, to).ok);
