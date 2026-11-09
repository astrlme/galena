import {
  INVITE_HOURS,
  inviteCreate,
  inviteCreated,
  inviteId,
  MAX_OPEN_INVITES,
  type MemberId,
  type MemberRole,
  memberId,
  memberUpdate,
  team,
} from "@galena/contracts";
import { checkInvite, checkTeamChange, type TeamChangeError } from "@galena/core";
import {
  countOpenInvites,
  createInvite,
  type Db,
  findInvite,
  findMemberByEmail,
  findOpenInvite,
  listTeam,
  lockTeam,
  removeMember,
  revokeInvite,
  setMemberRole,
} from "@galena/db";
import { inviteUrl } from "@galena/integrations/secrets";
import { createRoute, z } from "@hono/zod-openapi";
import { v7 } from "uuid";
import { type App, type Deps, fail, type Member, notFound, requireRole } from "../http.ts";
import {
  assertUnderCap,
  changeOf,
  commit,
  json,
  jsonBody,
  newTokenTime,
  noContent,
  startJob,
} from "./shared.ts";

// The team: who is a member and with what role, and invites by email. A signed-in admin or owner
// manages it (never an API key); anything involving an owner, an owner's invite included, needs
// an owner, and the last owner stays one. Accepting an invite is in `invite-accept.ts`.

const HOUR = 3_600_000;
const session = [{ session: [] }];

const REFUSALS: Record<TeamChangeError, { status: 403 | 409; title: string }> = {
  not_allowed: { status: 403, title: "You can't change that" },
  last_owner: { status: 409, title: "A workspace needs an owner" },
};

/** A refusal from the team rules, as a problem the dashboard shows. */
function refuse(error: { code: TeamChangeError; message: string }): never {
  return fail({ ...REFUSALS[error.code], code: error.code, detail: error.message });
}

export function registerTeamRoutes(app: App, deps: Deps) {
  const { db, keys } = deps;
  const viewer = requireRole(deps, "viewer");
  const admin = requireRole(deps, "admin", { apiKeys: false });

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/team",
      tags: ["Workspace"],
      summary: "Members and open invites",
      middleware: [viewer],
      responses: { 200: json(team, "The team") },
    }),
    async (c) => {
      const me = c.get("member");
      const { members, invites } = await listTeam(db, me.workspaceId, new Date());
      return c.json(
        {
          members: members.map(({ userId, joinedAt, ...m }) => ({
            ...m,
            joinedAt: joinedAt.toISOString(),
            isYou: userId === me.userId,
          })),
          invites: invites.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/invites",
      tags: ["Workspace"],
      summary: "Invite someone by email",
      description: `Makes a link that works once, for ${INVITE_HOURS} hours, for an account with this email only, and emails it where the deployment sends email. The link is in this response only. A new invite for the same address replaces the open one. Only an owner can invite an owner, or replace an owner's invite.`,
      security: session,
      middleware: [admin],
      request: jsonBody(inviteCreate),
      responses: { 201: json(inviteCreated, "The invite, with its link") },
    }),
    async (c) => {
      const me = c.get("member");
      const { email, role } = c.req.valid("json");
      const now = newTokenTime();
      const replaced = await findOpenInvite(db, me.workspaceId, email, now);
      for (const asked of [role, replaced?.role]) {
        const allowed = asked ? checkInvite(me.role, asked) : undefined;
        if (allowed && !allowed.ok) refuse(allowed.error);
      }
      if (await findMemberByEmail(db, me.workspaceId, email)) {
        fail({
          status: 409,
          code: "already_member",
          title: "Already on the team",
          detail: `${email} is a member of this workspace already. Change their role instead.`,
        });
      }
      assertUnderCap(
        "open invites",
        await countOpenInvites(db, me.workspaceId, now),
        MAX_OPEN_INVITES,
      );
      const id = inviteId.parse(v7());
      const expiresAt = new Date(now.getTime() + INVITE_HOURS * HOUR);
      // The audit entry names the invite only: the address stays out of the log.
      await commit(deps, changeOf(me, "invite", "created", [id], { role }), async (tx) => {
        const value = { id, workspaceId: me.workspaceId, email, role, invitedByUserId: me.userId };
        if (!(await createInvite(tx, { ...value, expiresAt }, now))) {
          fail({
            status: 409,
            code: "already_invited",
            title: "Invited a moment ago",
            detail: `Someone invited ${email} at the same moment. Look at the open invites.`,
          });
        }
      });
      const emailed =
        deps.subscriptions &&
        (await startJob(
          deps,
          "notify.email",
          { kind: "invite", inviteId: id },
          { idempotencyKey: `send:invite:${id}` },
          { inviteId: id },
        ));
      const made = await findInvite(db, id);
      return c.json(
        {
          id,
          email,
          role,
          expiresAt: expiresAt.toISOString(),
          invitedBy: made?.invitedBy ?? null,
          link: inviteUrl(keys, deps.publicUrl, id, now),
          emailed,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/invites/{id}",
      tags: ["Workspace"],
      summary: "Cancel an open invite",
      description: "Only an owner can cancel an owner's invite.",
      security: session,
      middleware: [admin],
      request: { params: z.object({ id: inviteId }) },
      responses: noContent,
    }),
    async (c) => {
      const me = c.get("member");
      const { id } = c.req.valid("param");
      const found = await findInvite(db, id);
      if (!found || found.workspaceId !== me.workspaceId) return notFound("Invite");
      const allowed = checkInvite(me.role, found.role);
      if (!allowed.ok) refuse(allowed.error);
      await commit(deps, changeOf(me, "invite", "deleted", [id]), async (tx) => {
        if (!(await revokeInvite(tx, me.workspaceId, id, new Date()))) notFound("Invite");
      });
      return c.body(null, 204);
    },
  );

  /**
   * Locks the team and lets the rules decide moving the member to `to`, with the actor's role as
   * it stands under the lock: two owners demoting others at once each see the other's change.
   */
  async function changeMember(tx: Db, me: Member, id: MemberId, to: MemberRole | "removed") {
    const members = await lockTeam(tx, me.workspaceId);
    const actor = members.find((m) => m.userId === me.userId);
    if (!actor) refuse({ code: "not_allowed", message: "You're no longer on this team." });
    const target = members.find((m) => m.id === id) ?? notFound("Member");
    const owners = members.filter((m) => m.role === "owner").length;
    const allowed = checkTeamChange({ actor: actor.role, from: target.role, to, owners });
    if (!allowed.ok) refuse(allowed.error);
    return target;
  }

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/members/{id}",
      tags: ["Workspace"],
      summary: "Change a member's role",
      description:
        "Only an owner can make or change an owner, and the last owner stays one. It applies from the member's next request.",
      security: session,
      middleware: [admin],
      request: { params: z.object({ id: memberId }), ...jsonBody(memberUpdate) },
      responses: noContent,
    }),
    async (c) => {
      const me = c.get("member");
      const { id } = c.req.valid("param");
      const { role } = c.req.valid("json");
      await commit(deps, changeOf(me, "member", "updated", [id], { role }), async (tx) => {
        await changeMember(tx, me, id, role);
        await setMemberRole(tx, id, role);
      });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/members/{id}",
      tags: ["Workspace"],
      summary: "Remove a member",
      description:
        "Signs them out everywhere and deletes their API keys. Only an owner can remove an owner, and the last owner stays.",
      security: session,
      middleware: [admin],
      request: { params: z.object({ id: memberId }) },
      responses: noContent,
    }),
    async (c) => {
      const me = c.get("member");
      const { id } = c.req.valid("param");
      await commit(deps, changeOf(me, "member", "deleted", [id]), async (tx) => {
        const target = await changeMember(tx, me, id, "removed");
        await removeMember(tx, target.id, target.userId);
      });
      return c.body(null, 204);
    },
  );
}
