import type { MemberRole, ProblemDetails, WorkspaceId } from "@galena/contracts";
import { problemContentType } from "@galena/contracts";
import { roleAtLeast, type WorkflowEngine } from "@galena/core";
import { type Db, findMembership } from "@galena/db";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Auth } from "./auth.ts";

export type Deps = { db: Db; auth: Auth; engine: WorkflowEngine };
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
