import type { MemberRole, ProblemDetails, WorkspaceId } from "@galena/contracts";
import { problemContentType } from "@galena/contracts";
import { roleAtLeast, type WorkflowEngine } from "@galena/core";
import { type Db, findMembership } from "@galena/db";
import type { Guard } from "@galena/integrations/net";
import type { AppKeys } from "@galena/integrations/secrets";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
};

/** Infra's CloudFront distributions add this header to requests they send to the API. */
export const ORIGIN_HEADER = "x-galena-origin";

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

/** 401 without a session, 403 below `required`; sets `member` for the handler. */
export function requireRole({ db, auth }: Deps, required: MemberRole): MiddlewareHandler<Env> {
  return async (c, next) => {
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
