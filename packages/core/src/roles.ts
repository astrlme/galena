import { type MemberRole, memberRoles } from "@galena/contracts";

/** Whether `actual` grants at least what `required` does (owner > admin > editor > viewer). */
export function roleAtLeast(actual: MemberRole, required: MemberRole): boolean {
  return memberRoles.indexOf(actual) <= memberRoles.indexOf(required);
}
