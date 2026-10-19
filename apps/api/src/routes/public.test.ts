import { expect, test } from "vitest";
import { createApp } from "../app.ts";
import { testDeps } from "../test-deps.ts";

// A database that fails as soon as anything asks it: a request answered normally was stopped
// before its first query.
const refusing = new Proxy(
  {},
  {
    get() {
      throw new Error("asked the database");
    },
  },
);
const post = (app: ReturnType<typeof createApp>, address: string) =>
  app.request("/public/subscribe", {
    method: "POST",
    body: new URLSearchParams({ email: "someone@example.com" }),
    headers: { "cloudfront-viewer-address": `${address}:443` },
  });

test("a network past its hourly sign-ups is answered as if it worked, without asking the database", async () => {
  const app = createApp({ ...testDeps().deps, db: refusing as never });
  for (let i = 0; i < 10; i++) expect((await post(app, "198.51.100.9")).status).toBe(500);
  const limited = await post(app, "198.51.100.9");
  expect([limited.status, limited.headers.get("location")]).toEqual([303, "/subscription/sent/"]);
  // Another network still gets through to the database.
  expect((await post(app, "198.51.100.10")).status).toBe(500);
});

test("IPv6 addresses count by their /64, so one network can't take a new address per post", async () => {
  const app = createApp({ ...testDeps().deps, db: refusing as never });
  for (let i = 1; i <= 10; i++) {
    expect((await post(app, `2001:db8:7:9::${i.toString(16)}`)).status).toBe(500);
  }
  expect((await post(app, "2001:db8:7:9:ffff::1")).status).toBe(303);
  expect((await post(app, "2001:db8:7:a::1")).status).toBe(500);
});
