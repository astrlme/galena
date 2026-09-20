import { type ProblemDetails, problemContentType } from "@galena/contracts";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";

/** An RFC 9457 response with our stable `code`. */
export function problem(c: Context, details: Omit<ProblemDetails, "type">): Response {
  const body: ProblemDetails = { type: "about:blank", ...details };
  return c.body(JSON.stringify(body), details.status as 400, {
    "content-type": problemContentType,
  });
}

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

export function createApp() {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (result.success) return;
      const fields = result.error.issues.map(
        (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
      );
      return problem(c, {
        status: 400,
        code: "validation_failed",
        title: "The request is not valid",
        detail: `Fix these fields and try again. ${fields.join("; ")}.`,
      });
    },
  });

  app.openapi(health, (c) => c.json({ status: "ok" as const }, 200));

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Galena API", version: "0.0.0" },
  });

  app.notFound((c) =>
    problem(c, {
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: `No route matches ${c.req.method} ${c.req.path}. Check the path against /openapi.json.`,
    }),
  );

  app.onError((error, c) => {
    // The cause goes to the logs only: it may hold SQL or secrets.
    console.error("unhandled error", {
      path: c.req.path,
      name: error.name,
      message: error.message,
    });
    return problem(c, {
      status: 500,
      code: "internal_error",
      title: "Something went wrong",
      detail: "The error was logged. Try again, and tell the owner if it keeps happening.",
    });
  });

  return app;
}
