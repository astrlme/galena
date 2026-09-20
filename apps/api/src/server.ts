// Local development server; in AWS the same app runs through lambda.ts.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { env } from "./env.ts";

serve({ fetch: createApp().fetch, port: env.GLN_API_PORT }, (info) => {
  console.log(`API on http://localhost:${info.port} (OpenAPI at /openapi.json)`);
});
