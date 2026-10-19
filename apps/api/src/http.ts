import { timingSafeEqual } from "node:crypto";
import type { MemberRole, ProblemDetails, SlackAppConfig, WorkspaceId } from "@galena/contracts";
import { problemContentType } from "@galena/contracts";
import { keyRole, roleAtLeast, type WorkflowEngine } from "@galena/core";
import { type Db, findApiKeyActor, findMembership } from "@galena/db";
import type { Guard } from "@galena/integrations/net";
import type { AppKeys } from "@galena/integrations/secrets";
import type { SlackApi } from "@galena/integrations/slack";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hashApiKey, isApiKey } from "./api-keys.ts";
import type { Auth } from "./auth.ts";
import type { Telemetry } from "./telemetry.ts";

export type Deps = {
  db: Db;
  auth: Auth;
  engine: WorkflowEngine;
  telemetry: Telemetry;
  /** The SSRF guard monitor URLs must pass when they are saved. */
  targets: Guard;
  /** Keys derived from the deployment's app key: sealing, link tokens, keyed hashes. */
  keys: AppKeys;
  /** The dashboard's origin, where the API also answers. */
  publicUrl: string;
  /**
   * Set in AWS: CloudFront sends it in `ORIGIN_HEADER` with every request it forwards. The
   * execute-api URL is public too, and there a caller could forge CloudFront-Viewer-Address.
   */
  originSecret?: string;
  /**
   * First-run setup: open locally. In AWS it needs the deployment's setup token, read at cold
   * start; without that parameter there is no token and setup is refused.
   */
  setup: "open" | { token?: string };
  /** Whether the status page takes subscriptions: not in a deployment that sends no email. */
  subscriptions: boolean;
  /** The deployment's Slack app, when its secrets exist; without them Slack's routes answer 404. */
  slack?: SlackAppConfig & { api: Pick<SlackApi, "exchangeCode" | "revoke"> };
};

/** Infra's CloudFront distributions add this header to requests they send to the API. */
export const ORIGIN_HEADER = "x-galena-origin";

/** First-run setup in AWS sends the deployment's setup token in this header. */
export const SETUP_TOKEN_HEADER = "x-galena-setup-token";

/** Compares a secret someone sent with ours in constant time. */
export function sameSecret(given: string, expected: string): boolean {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The visitor's address from CloudFront's `ip:port` (IPv6 too: the port follows the last colon).
 * Trusted because requests only arrive through CloudFront, which sets it.
 */
export function viewerAddress(headers: Headers): string | undefined {
  const address = headers.get("cloudfront-viewer-address");
  return address ? address.slice(0, address.lastIndexOf(":")) : undefined;
}
export type Member = { userId: string; email: string; role: MemberRole; workspaceId: WorkspaceId };
export type Env = { Variables: { member: Member } };
export type App = OpenAPIHono<Env>;

/** An RFC 9457 response with our stable `code`. */
export function problemResponse(details: Omit<ProblemDetails, "type">): Response {
  const body: ProblemDetails = { type: "about:blank", ...details };
  return new Response(JSON.stringify(body), {
    status: details.status,
    headers: { "content-type": problemContentType },
  });
}

/** For expected failures inside typed handlers; `onError` sends the problem as is. */
export function fail(details: Omit<ProblemDetails, "type">): never {
  throw new HTTPException(details.status as ContentfulStatusCode, {
    res: problemResponse(details),
  });
}

export function notFound(what: string): never {
  return fail({
    status: 404,
    code: "not_found",
    title: `${what} not found`,
    detail: `No ${what.toLowerCase()} has that id in this workspace. Reload the page and try again.`,
  });
}

/** The credentials of `Authorization: Bearer …`, whatever the scheme's case. */
const bearerOf = (header: string | undefined) => /^bearer\s+(.*)$/i.exec(header ?? "")?.[1];

/**
 * The member a key acts as: its maker, at most at the key's scope. Only something shaped like a
 * key reaches the database, so noise can't wake a paused cluster.
 */
async function keyMember(db: Db, key: string): Promise<Member | undefined> {
  if (!isApiKey(key)) return undefined;
  const actor = await findApiKeyActor(db, hashApiKey(key));
  if (!actor) return undefined;
  // Known limit: audit entries name the key's maker, not the key; carry the key's id in
  // `Member` and `changeOf` if telling a script's changes from its maker's matters.
  return {
    userId: actor.userId,
    email: actor.email,
    role: keyRole(actor.scope, actor.role),
    workspaceId: actor.workspaceId,
  };
}

/**
 * 401 without a session or a valid API key, 403 below `required`; sets `member` for the
 * handler. A key acts as the member who made it, at most at its scope's role (`keyRole`).
 * `keys: false` takes a signed-in member only: keys can't make more keys.
 */
export function requireRole(
  { db, auth }: Deps,
  required: MemberRole,
  { keys = true } = {},
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = bearerOf(c.req.header("authorization"));
    // Whoever sends a key is answered about the key, never as a visitor without a session.
    if (key !== undefined) {
      if (!keys) {
        return problemResponse({
          status: 403,
          code: "session_required",
          title: "Sign in to do this",
          detail: "API keys can't do this. Sign in to the dashboard instead.",
        });
      }
      const member = await keyMember(db, key);
      if (!member) {
        return problemResponse({
          status: 401,
          code: "invalid_api_key",
          title: "This API key isn't valid",
          detail:
            "It was deleted, or whoever made it left the workspace. Make a new key in Settings.",
        });
      }
      if (!roleAtLeast(member.role, required)) {
        return problemResponse({
          status: 403,
          code: "forbidden",
          title: "This key's scope does not allow this",
          detail: `This needs the ${required} role or higher; the key acts as ${member.role}. Use a key with a wider scope.`,
        });
      }
      c.set("member", member);
      return next();
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return problemResponse({
        status: 401,
        code: "unauthenticated",
        title: "Sign in first",
        detail: "This needs a signed-in member. Sign in and try again.",
      });
    }
    const membership = await findMembership(db, session.user.id);
    if (!membership || !roleAtLeast(membership.role, required)) {
      return problemResponse({
        status: 403,
        code: "forbidden",
        title: "Your role does not allow this",
        detail: `This needs the ${required} role or higher. Ask an owner to change your role.`,
      });
    }
    c.set("member", { userId: session.user.id, email: session.user.email, ...membership });
    await next();
  };
}
