import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { openApiDocument } from "./openapi.ts";

test("openapi.json matches the routes (run pnpm api:generate if not)", () => {
  const committed = readFileSync(new URL("../openapi.json", import.meta.url), "utf8");
  expect(committed).toBe(openApiDocument());
});
