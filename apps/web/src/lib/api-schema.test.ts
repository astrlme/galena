import { readFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
import { expect, test } from "vitest";

test("api-schema.ts matches apps/api/openapi.json (run pnpm api:generate if not)", async () => {
  const ast = await openapiTS(new URL("../../../api/openapi.json", import.meta.url));
  const committed = readFileSync(new URL("./api-schema.ts", import.meta.url), "utf8");
  expect(committed).toContain(astToString(ast));
});
