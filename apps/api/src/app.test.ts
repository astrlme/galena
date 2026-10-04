import { problemContentType, problemDetails } from "@galena/contracts";
import { createRoute, z } from "@hono/zod-openapi";
import { Validator } from "@seriousme/openapi-schema-validator";
import { expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { testDeps } from "./test-deps.ts";

const newApp = () => createApp(testDeps().deps);

async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain(problemContentType);
  const body = problemDetails.parse(await response.json());
  expect(body).toMatchObject({ status, code });
  return body;
}

test("GET /health answers without touching the database", async () => {
  const response = await newApp().request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("/openapi.json is a valid OpenAPI 3.1 document that lists /health", async () => {
  const response = await newApp().request("/openapi.json");
  const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
  const result = await new Validator().validate(document);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(document.openapi).toMatch(/^3\.1\./);
  expect(Object.keys(document.paths)).toContain("/health");
});

test("an unknown route answers 404 problem details", async () => {
  const body = await expectProblem(await newApp().request("/nope"), 404, "not_found");
  expect(body.detail).toContain("GET /nope");
});

test("invalid input answers 400 problem details naming the field", async () => {
  const app = newApp();
  const route = createRoute({
    method: "get",
    path: "/echo",
    request: { query: z.object({ limit: z.coerce.number().int().max(100) }) },
    responses: { 200: { description: "Echo" } },
  });
  app.openapi(route, (c) => c.json({ limit: c.req.valid("query").limit }, 200));

  expect((await app.request("/echo?limit=5")).status).toBe(200);
  const body = await expectProblem(await app.request("/echo?limit=500"), 400, "validation_failed");
  expect(body.detail).toContain("limit");
});

test("an unexpected error answers 500 problem details without leaking the cause", async () => {
  const app = newApp();
  app.get("/boom", () => {
    throw new Error("password=hunter2 in SELECT * FROM secrets");
  });
  const response = await app.request("/boom");
  const text = await response.clone().text();
  await expectProblem(response, 500, "internal_error");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("SELECT");
});

test("a failed query is logged without its parameters", async () => {
  const app = newApp();
  app.get("/query", () => {
    throw new Error('Failed query: select * from "session" where "token" = $1\nparams: tok_secret');
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expectProblem(await app.request("/query"), 500, "internal_error");
  const logged = JSON.stringify(log.mock.calls);
  log.mockRestore();
  expect(logged).toContain("Failed query");
  expect(logged).not.toContain("tok_secret");
});

test("with an origin secret, only requests carrying it reach a route; /health stays open", async () => {
  const app = createApp({ ...testDeps().deps, originSecret: "from-cloudfront" });
  await expectProblem(await app.request("/nope"), 403, "not_through_cloudfront");
  const forged = { headers: { "x-galena-origin": "guess" } };
  await expectProblem(await app.request("/nope", forged), 403, "not_through_cloudfront");
  const through = { headers: { "x-galena-origin": "from-cloudfront" } };
  await expectProblem(await app.request("/nope", through), 404, "not_found");
  expect((await app.request("/health")).status).toBe(200);
});
