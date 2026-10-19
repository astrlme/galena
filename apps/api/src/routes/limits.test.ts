import { integrationId } from "@galena/contracts";
import { linkToken } from "@galena/integrations/secrets";
import { v7 } from "uuid";
import { expect, test } from "vitest";
import { createApp } from "../app.ts";
import { testDeps } from "../test-deps.ts";

// No database here: testDeps points at one that isn't running, so a request that got past a
// limit and asked it would fail. Answering normally means the limit stopped it first.

test("a network past its hourly sign-ups is answered as if it worked, without asking the database", async () => {
  const app = createApp(testDeps().deps);
  const post = () =>
    app.request("/public/subscribe", {
      method: "POST",
      body: new URLSearchParams({ email: "someone@example.com" }),
      headers: { "cloudfront-viewer-address": "198.51.100.9:443" },
    });
  for (let i = 0; i < 10; i++) expect((await post()).status).toBe(500); // reached the database
  const limited = await post();
  expect([limited.status, limited.headers.get("location")]).toEqual([303, "/subscription/sent/"]);
});

test("a hook past its alerts a minute gets 429 and starts no more jobs", async () => {
  const built = testDeps();
  const app = createApp(built.deps);
  const id = integrationId.parse(v7());
  const url = `/hooks/generic/${linkToken(built.deps.keys, "hook", id, new Date())}`;
  const alerts = (n: number) =>
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        key: `alert-${i}`,
        status: "firing",
        startsAt: "2026-10-19T12:00:00Z",
      })),
    );
  const send = (n: number) =>
    app.request(url, {
      method: "POST",
      body: alerts(n),
      headers: { "content-type": "application/json" },
    });
  expect((await send(100)).status).toBe(202);
  const refused = await send(30);
  expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
  expect(built.triggered.filter((t) => t.task === "signal.ingest")).toHaveLength(100);
  expect((await send(20)).status).toBe(202);
});
