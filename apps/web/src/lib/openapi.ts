import { createOpenAPI } from "fumadocs-openapi/server";

// The API's own document, written by `pnpm api:generate`; the path is relative to apps/web.
export const openapi = createOpenAPI({ input: ["../api/openapi.json"] });
