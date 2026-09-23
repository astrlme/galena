// Writes apps/api/openapi.json, which the dashboard's typed client is generated from.
// Run `pnpm api:generate` after changing a route; openapi.test.ts fails while it is stale.
import { writeFileSync } from "node:fs";
import { createApp, openApiConfig } from "./app.ts";
import { testDeps } from "./test-deps.ts";

export const openApiDocument = () =>
  `${JSON.stringify(createApp(testDeps().deps).getOpenAPI31Document(openApiConfig), null, 2)}\n`;

if (import.meta.main) {
  writeFileSync(new URL("../openapi.json", import.meta.url), openApiDocument());
}
