import { readFile } from "node:fs/promises";

// The API's OpenAPI document, published as a static file with every build: the dashboard's
// address serves the description of the API that answers there. Read like the docs read it,
// by its path relative to apps/web, written by `pnpm api:generate`.
export const revalidate = false;
export async function GET() {
  const document = await readFile("../api/openapi.json", "utf8");
  return new Response(document, { headers: { "content-type": "application/json" } });
}
