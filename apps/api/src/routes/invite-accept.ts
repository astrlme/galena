import { INVITE_HOURS, inviteAccept, inviteId, invitePreview, memberId } from "@galena/contracts";
import { inviteState } from "@galena/core";
import { claimInvite, findInvite, findUserByEmail, findWorkspaceName } from "@galena/db";
import { readLinkToken } from "@galena/integrations/secrets";
import { createRoute, z } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { v7 } from "uuid";
import { type App, type Deps, fail } from "../http.ts";
import { changeOf, commit, json, jsonBody } from "./shared.ts";

// Opening an invite link: what it's for, then joining. Anyone holding the link may ask, so the
// link's signature and age are checked before the database. Accepting is the one way to make an
// account once the workspace exists, and the account takes the invited address.

const HOUR = 3_600_000;

const invalid = (detail: string) =>
  fail({ status: 404, code: "invite_invalid", title: "This invite link isn't valid", detail });
const expired = () =>
  fail({
    status: 410,
    code: "invite_expired",
    title: "This invite has expired",
    detail: `Invites work for ${INVITE_HOURS} hours. Ask whoever invited you for a new one.`,
  });
const closed = (detail: string) =>
  fail({ status: 410, code: "invite_closed", title: "This invite can't be used any more", detail });

export function registerInviteRoutes(app: App, deps: Deps) {
  const { db, keys, auth } = deps;

  /** The open invite a link names: a link that isn't ours or is past its time never wakes Aurora. */
  async function inviteOf(token: string) {
    const read = readLinkToken(keys, "invite", token);
    const id = inviteId.safeParse(read?.id);
    if (!read || !id.success) {
      return invalid("Check that the whole link was copied, or ask for a new invite.");
    }
    if (read.issuedAt.getTime() + INVITE_HOURS * HOUR <= Date.now()) return expired();
    const found = await findInvite(db, id.data);
    if (!found || found.createdAt.getTime() !== read.issuedAt.getTime()) {
      return invalid("Ask whoever invited you for a new invite.");
    }
    const state = inviteState(found, new Date());
    if (state === "used") return closed("It has been used. Sign in instead.");
    if (state === "revoked") return closed("It was replaced or cancelled. Ask for a new invite.");
    if (state === "expired") return expired();
    return found;
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/invites/preview",
      tags: ["Workspace"],
      summary: "What an invite link is for",
      description:
        "For the invite page: the address, the role and the workspace. Needs only the link's token.",
      security: [],
      request: { query: z.object({ token: z.string().min(1).max(300) }) },
      responses: { 200: json(invitePreview, "The invite") },
    }),
    async (c) => {
      const found = await inviteOf(c.req.valid("query").token);
      const [workspaceName, account] = await Promise.all([
        findWorkspaceName(db, found.workspaceId),
        findUserByEmail(db, found.email),
      ]);
      return c.json(
        {
          email: found.email,
          role: found.role,
          workspaceName: workspaceName ?? "",
          expiresAt: found.expiresAt.toISOString(),
          hasAccount: account !== undefined,
        },
        200,
      );
    },
  );

  /** A new account for the invited address, signed in: its id and the session cookies. */
  async function signUp(email: string, name?: string, password?: string) {
    if (!name || !password) {
      fail({
        status: 422,
        code: "account_details_required",
        title: "Your name and a password are needed",
        detail: "Enter your name and a password of at least 12 characters.",
      });
    }
    const made = await auth.api
      .signUpEmail({ body: { name, email, password }, returnHeaders: true })
      .catch((error: unknown) => {
        if (!(error instanceof APIError)) throw error;
        return fail({
          status: error.statusCode,
          code: "sign_up_rejected",
          title: "Couldn't create your account",
          detail: error.body?.message ?? error.message,
        });
      });
    return { userId: made.response.user.id, cookies: made.headers.getSetCookie() };
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/invites/accept",
      tags: ["Workspace"],
      summary: "Accept an invite",
      description:
        "A new account sends a name and a password, and is signed in. An address that has an account already accepts while signed in as it.",
      security: [],
      request: jsonBody(inviteAccept),
      responses: {
        201: json(
          z.object({ workspaceId: z.string() }),
          "Joined; a new account's response sets the session cookie",
        ),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const found = await inviteOf(body.token);
      const existing = await findUserByEmail(db, found.email);
      let joiner: { userId: string; cookies: string[] };
      if (existing) {
        const signedIn = await auth.api
          .getSession({ headers: c.req.raw.headers })
          .catch(() => null);
        if (signedIn?.user.email.toLowerCase() !== found.email) {
          fail({
            status: 409,
            code: "sign_in_first",
            title: "Sign in to accept",
            detail: `${found.email} has an account already. Sign in as it, then open the invite link again.`,
          });
        }
        joiner = { userId: existing.id, cookies: [] };
      } else {
        // Known limit: the account is made before the invite is claimed, so if it's cancelled or
        // used in between, the account is left off the team; it grants nothing, and a new invite
        // to the address lets it in.
        joiner = await signUp(found.email, body.name, body.password);
      }
      const member = memberId.parse(v7());
      const actor = {
        ...joiner,
        email: found.email,
        role: found.role,
        workspaceId: found.workspaceId,
      };
      const change = changeOf(actor, "member", "created", [member], { role: found.role });
      await commit(deps, change, async (tx) => {
        const input = {
          inviteId: found.id,
          userId: joiner.userId,
          memberId: member,
          now: new Date(),
        };
        if (!(await claimInvite(tx, input))) {
          closed("It was used a moment ago, or you're on the team already. Sign in instead.");
        }
      });
      for (const cookie of joiner.cookies) c.header("set-cookie", cookie, { append: true });
      return c.json({ workspaceId: found.workspaceId }, 201);
    },
  );
}
