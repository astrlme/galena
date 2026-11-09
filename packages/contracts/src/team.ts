import { z } from "zod";
import { memberRoles } from "./enums.ts";
import { inviteId, memberId } from "./ids.ts";

// The workspace's people: its members, the invites still open, and accepting one.

/** How long an invite's link works. */
export const INVITE_HOURS = 48;
/** Most invites open at once. */
export const MAX_OPEN_INVITES = 50;

const role = z.enum(memberRoles);

export const teamMember = z.object({
  id: memberId,
  name: z.string(),
  email: z.string(),
  role,
  joinedAt: z.iso.datetime(),
  /** The member asking. */
  isYou: z.boolean(),
});
export type TeamMember = z.infer<typeof teamMember>;

export const openInvite = z.object({
  id: inviteId,
  email: z.string(),
  role,
  expiresAt: z.iso.datetime(),
  /** Who sent it; null once they've left. */
  invitedBy: z.string().nullable(),
});
export type OpenInvite = z.infer<typeof openInvite>;

export const team = z.object({ members: z.array(teamMember), invites: z.array(openInvite) });
export type Team = z.infer<typeof team>;

export const inviteCreate = z.object({
  email: z.email("Enter an email address such as ada@example.com.").trim().toLowerCase(),
  role,
});
export type InviteCreate = z.infer<typeof inviteCreate>;

/** The link to accept an invite: anyone holding it can join as that address. */
export const inviteLink = z.object({ link: z.url() });

export const inviteCreated = openInvite.extend({
  link: z.url(),
  /** False where the deployment sends no email: share the link yourself. */
  emailed: z.boolean(),
});

export const memberUpdate = z.object({ role });

/** What the invite page shows before anyone signs up. */
export const invitePreview = z.object({
  email: z.string(),
  role,
  workspaceName: z.string(),
  expiresAt: z.iso.datetime(),
  /** The address has an account already: sign in as it, then accept. */
  hasAccount: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreview>;

/** A new account needs a name and a password; an existing one accepts while signed in as it. */
export const inviteAccept = z.object({
  token: z.string().min(1).max(300),
  name: z.string().trim().min(1, "Enter your name.").max(100).optional(),
  password: z
    .string()
    .min(12, "Use at least 12 characters.")
    .max(128, "Use at most 128 characters.")
    .optional(),
});
export type InviteAccept = z.infer<typeof inviteAccept>;
