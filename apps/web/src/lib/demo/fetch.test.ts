import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { demoFetch, READ_ONLY } from "./fetch.ts";

const origin = "https://demo.example.com";
const get = (path: string) => demoFetch(new Request(`${origin}${path}`));

// Every GET the dashboard makes, read from its source, so a new screen can't go unanswered.
const src = join(import.meta.dirname, "../..");
const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
  f.endsWith(".tsx"),
);
const gets = new Set(
  files.flatMap((f) =>
    [...readFileSync(join(src, f), "utf8").matchAll(/\.GET\(\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
  ),
);

test("answers every GET the dashboard makes", async () => {
  expect(gets.size).toBeGreaterThan(5);
  const { incidents } = await (await get("/v1/incidents")).json();
  for (const path of gets) {
    const response = await get(path.replace("{id}", incidents[0].id));
    expect(response.status, path).toBe(200);
  }
});

test("open and resolved incidents are told apart, and one draft waits for approval", async () => {
  const open = (await (await get("/v1/incidents?state=open")).json()).incidents;
  const resolved = (await (await get("/v1/incidents?state=resolved")).json()).incidents;
  expect(open.every((i: { resolvedAt: string | null }) => i.resolvedAt === null)).toBe(true);
  expect(resolved.every((i: { resolvedAt: string | null }) => i.resolvedAt !== null)).toBe(true);
  expect(open.filter((i: { visibility: string }) => i.visibility === "draft")).toHaveLength(1);
});

test("signs the visitor in as the demo owner", async () => {
  expect((await (await get("/v1/me")).json()).role).toBe("owner");
  expect((await (await get("/auth/get-session")).json()).user.email).toBe("owner@example.com");
});

test("refuses every change with a message the dashboard shows", async () => {
  for (const [method, path] of [
    ["POST", "/v1/monitors"],
    ["PUT", "/v1/components/order"],
    ["DELETE", "/v1/subscribers/x"],
    ["POST", "/auth/change-password"],
  ] as const) {
    const response = await demoFetch(new Request(`${origin}${path}`, { method }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.detail).toBe(READ_ONLY);
    expect(body.message).toBe(READ_ONLY);
  }
});

test("an unknown route is a 404", async () => {
  expect((await get("/v1/nothing-here")).status).toBe(404);
  expect((await get("/v1/incidents/not-an-incident")).status).toBe(404);
});
