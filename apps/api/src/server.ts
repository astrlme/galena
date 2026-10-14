// Local development: the API on a port, with the job engine the dev process hands it; in AWS
// the same app runs through lambda.ts.
import type { WorkflowEngine } from "@galena/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createDeps } from "./deps.ts";
import { env } from "./env.ts";

export async function startApi(engine: WorkflowEngine) {
  const app = createApp({ ...(await createDeps()), engine });
  serve({ fetch: app.fetch, port: env.GLN_API_PORT }, (info) => {
    console.log(`API on http://localhost:${info.port} (OpenAPI at /openapi.json)`);
  });
}
