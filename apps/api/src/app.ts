import { memberId, workspaceId } from "@galena/contracts";
import { createWorkspace, workspaceExists } from "@galena/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import { v7 } from "uuid";
import { CLIENT_IP_HEADER } from "./auth.ts";
import {
  type Deps,
  type Env,
  fail,
  ORIGIN_HEADER,
  problemResponse,
  requireRole,
  SETUP_TOKEN_HEADER,
  sameSecret,
  viewerAddress,
} from "./http.ts";
import { registerComponentRoutes } from "./routes/components.ts";
import { registerIncidentRoutes } from "./routes/incidents.ts";
import { registerMaintenanceRoutes } from "./routes/maintenance.ts";
import { registerMonitorRoutes } from "./routes/monitors.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { registerSlackRoutes } from "./routes/slack.ts";

export { type Deps, problemResponse, requireRole } from "./http.ts";

export const openApiConfig = {
  openapi: "3.1.0",
  info: { title: "Galena API", version: "0.0.0" },
  tags: [
    { name: "Workspace", description: "Health, first-run setup and the signed-in member." },
    { name: "Components", description: "Components and groups, in the order the page shows them." },
    { name: "Monitors", description: "HTTP monitors, their settings and their latest results." },
    { name: "Incidents", description: "Incidents and their updates." },
    { name: "Maintenance", description: "Scheduled maintenance windows." },
    {
      name: "Notifications",
      description: "Slack and webhook endpoints, email subscribers, and the Slack app.",
    },
  ],
};

const health = createRoute({
  method: "get",
  path: "/health",
  tags: ["Workspace"],
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
  tags: ["Workspace"],
  summary: "First-run setup",
  description:
    "Creates the workspace and its owner, then signs the owner in. Works once per deployment. In AWS it needs the deployment's setup token (the `/galena/<name>/setup-token` SecureString) in `x-galena-setup-token`, and answers 403 without it.",
  request: {
    headers: z.object({ [SETUP_TOKEN_HEADER]: z.string().optional() }),
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
  tags: ["Workspace"],
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

  // Only requests that came through CloudFront: the per-visitor limits trust the address it
  // adds. Health checks may come from anywhere.
  const { originSecret } = deps;
  if (originSecret) {
    app.use("*", async (c, next) => {
      if (c.req.path === "/health" || sameSecret(c.req.header(ORIGIN_HEADER) ?? "", originSecret)) {
        return next();
      }
      return problemResponse({
        status: 403,
        code: "not_through_cloudfront",
        title: "Use the dashboard's address",
        detail: "The API answers through the dashboard and status page addresses only.",
      });
    });
  }

  app.openapi(health, (c) => c.json({ status: "ok" as const }, 200));

  // Better Auth: sign-in, sign-out, sessions, two-factor, GitHub OAuth. Its rate limits key on
  // the visitor's address, which only we set, from CloudFront's.
  app.on(["GET", "POST"], "/auth/*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const address = viewerAddress(headers);
    if (address) headers.set(CLIENT_IP_HEADER, address);
    return auth.handler(new Request(c.req.raw, { headers }));
  });

  app.openapi(setup, async (c) => {
    // Checked before the database, so a caller without the token never wakes Aurora.
    if (deps.setup !== "open") {
      const { token } = deps.setup;
      const given = c.req.valid("header")[SETUP_TOKEN_HEADER];
      if (!token || !given || !sameSecret(given, token)) {
        fail({
          status: 403,
          code: "setup_token_required",
          title: "First-run setup needs the setup token",
          detail: `Create the SecureString /galena/<name>/setup-token if it doesn't exist, then send its value in ${SETUP_TOKEN_HEADER}.`,
        });
      }
    }
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
  registerIncidentRoutes(app, deps);
  registerMaintenanceRoutes(app, deps);
  registerNotificationRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerSlackRoutes(app, deps);

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
    // The cause goes to the logs only, and only the statement: a failed query's message ends with
    // its bound parameters (session tokens, email addresses).
    console.error("unhandled error", {
      path: c.req.path,
      name: error.name,
      message: error.message.split("\nparams:")[0],
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
