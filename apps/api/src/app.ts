import { memberId, workspaceId } from "@galena/contracts";
import { createWorkspace, workspaceExists } from "@galena/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import { v7 } from "uuid";
import { type Deps, type Env, fail, problemResponse, requireRole } from "./http.ts";
import { registerComponentRoutes } from "./routes/components.ts";
import { registerMonitorRoutes } from "./routes/monitors.ts";

export { type Deps, problemResponse, requireRole } from "./http.ts";

export const openApiConfig = {
  openapi: "3.1.0",
  info: { title: "Galena API", version: "0.0.0" },
} as const;

const health = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness",
  description: "Answers without touching the database, so health checks never wake Aurora.",
  responses: {
    200: {
      description: "The API is running",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
  },
});

const setup = createRoute({
  method: "post",
  path: "/v1/setup",
  summary: "First-run setup",
  description:
    "Creates the workspace and its owner, then signs the owner in. Works once per deployment.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            workspaceName: z.string().trim().min(1).max(100),
            name: z.string().trim().min(1).max(100),
            email: z.email(),
            password: z.string().min(12).max(128),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace and owner created; the response sets the session cookie",
      content: {
        "application/json": { schema: z.object({ workspaceId: z.string(), userId: z.string() }) },
      },
    },
  },
});

const me = createRoute({
  method: "get",
  path: "/v1/me",
  summary: "The signed-in member",
  responses: {
    200: {
      description: "Who is signed in and their role",
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string(),
            email: z.string(),
            role: z.string(),
            workspaceId: z.string(),
          }),
        },
      },
    },
  },
});

export function createApp(deps: Deps) {
  const { db, auth } = deps;
  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (result.success) return;
      const fields = result.error.issues.map(
        (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
      );
      return problemResponse({
        status: 400,
        code: "validation_failed",
        title: "The request is not valid",
        detail: `Fix these fields and try again. ${fields.join("; ")}.`,
      });
    },
  });

  app.openapi(health, (c) => c.json({ status: "ok" as const }, 200));

  // Better Auth: sign-in, sign-out, sessions, two-factor, GitHub OAuth.
  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

  app.openapi(setup, async (c) => {
    if (await workspaceExists(db)) {
      fail({
        status: 409,
        code: "already_set_up",
        title: "This deployment is already set up",
        detail: "Sign in instead, or ask an owner to invite you.",
      });
    }
    const { workspaceName, name, email, password } = c.req.valid("json");
    const signUp = await auth.api
      .signUpEmail({ body: { name, email, password }, returnHeaders: true })
      .catch(async (error: unknown) => {
        if (!(error instanceof APIError)) throw error;
        // A setup that failed after creating the owner (Aurora resuming mid-way, say) finishes on
        // a second try: with no workspace yet, the same email and password sign in instead.
        if (String(error.body?.code ?? "").startsWith("USER_ALREADY_EXISTS")) {
          const signIn = await auth.api
            .signInEmail({ body: { email, password }, returnHeaders: true })
            .catch(() => undefined);
          if (signIn) return signIn;
        }
        return fail({
          status: error.statusCode,
          code: "sign_up_rejected",
          title: "Couldn't create the owner account",
          detail: error.body?.message ?? error.message,
        });
      });
    const id = workspaceId.parse(v7());
    const userId = signUp.response.user.id;
    const outcome = await createWorkspace(db, {
      id,
      name: workspaceName,
      owner: { memberId: memberId.parse(v7()), userId },
    });
    if (outcome === "exists") {
      // Known limit: the loser of a setup race keeps an account with no membership, which grants
      // nothing; clean it up by hand if it ever happens.
      fail({
        status: 409,
        code: "already_set_up",
        title: "This deployment is already set up",
        detail: "Another setup finished first. Sign in instead, or ask an owner to invite you.",
      });
    }
    for (const cookie of signUp.headers.getSetCookie()) {
      c.header("set-cookie", cookie, { append: true });
    }
    return c.json({ workspaceId: id, userId }, 201);
  });

  app.use("/v1/me", requireRole(deps, "viewer"));
  app.openapi(me, (c) => c.json(c.get("member"), 200));

  registerComponentRoutes(app, deps);
  registerMonitorRoutes(app, deps);

  app.doc31("/openapi.json", openApiConfig);

  app.notFound((c) =>
    problemResponse({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: `No route matches ${c.req.method} ${c.req.path}. Check the path against /openapi.json.`,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // The cause goes to the logs only: it may hold SQL or secrets.
    console.error("unhandled error", {
      path: c.req.path,
      name: error.name,
      message: error.message,
    });
    return problemResponse({
      status: 500,
      code: "internal_error",
      title: "Something went wrong",
      detail: "The error was logged. Try again, and tell the owner if it keeps happening.",
    });
  });

  return app;
}
