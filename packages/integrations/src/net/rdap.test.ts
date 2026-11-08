import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { lookUpDomains, registeredDomain } from "./rdap.ts";
import { createGuard, guard } from "./ssrf.ts";

// A local server plays IANA's bootstrap and one registry, which serves `.test` domains; only
// this guard may reach 127.0.0.1.
const testGuard = createGuard({
  allowAddresses: ["127.0.0.1"],
  resolve: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
});
let server: Server;
let origin: string;
let bootstrapStatus = 200;

const replies: Record<string, { status: number; body?: unknown }> = {
  "/rdap/domain/example.test": {
    status: 200,
    body: {
      objectClassName: "domain",
      events: [
        { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
        { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
      ],
    },
  },
  "/rdap/domain/no-expiry.test": { status: 200, body: { objectClassName: "domain", events: [] } },
  "/rdap/domain/gone.test": { status: 404, body: { errorCode: 404 } },
  "/rdap/domain/broken.test": { status: 503 },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/dns.json") {
      const body = { version: "1.0", services: [[["test"], [`${origin}/rdap/`]]] };
      return res.writeHead(bootstrapStatus).end(JSON.stringify(body));
    }
    const reply = replies[req.url ?? ""] ?? { status: 404 };
    res.writeHead(reply.status, { "content-type": "application/rdap+json" });
    res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://registry.local:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const lookUp = (domains: string[]) =>
  lookUpDomains(domains, { guard: testGuard, bootstrapUrl: `${origin}/dns.json` });

test("finds the registered domain behind a host name", () => {
  expect(registeredDomain("api.example.co.uk")).toBe("example.co.uk");
  expect(registeredDomain("status.example.com")).toBe("example.com");
  expect(registeredDomain("203.0.113.9")).toBeNull();
});

test("reads a domain's expiry from its registry's events", async () => {
  const lookups = await lookUp(["example.test"]);
  expect(lookups.get("example.test")).toEqual({
    status: "found",
    expiresAt: "2027-08-13T04:00:00.000Z",
  });
});

test("reads no expiry when the registry publishes none, has no RDAP server or no such domain", async () => {
  const lookups = await lookUp(["no-expiry.test", "astrl.me", "gone.test"]);
  for (const domain of ["no-expiry.test", "astrl.me", "gone.test"]) {
    expect(lookups.get(domain)).toEqual({ status: "found", expiresAt: null });
  }
});

test("reports a failed lookup so the last known expiry stays", async () => {
  expect((await lookUp(["broken.test"])).get("broken.test")).toEqual({ status: "failed" });
  bootstrapStatus = 503;
  try {
    expect((await lookUp(["example.test"])).get("example.test")).toEqual({ status: "failed" });
  } finally {
    bootstrapStatus = 200;
  }
});

test("asks nothing of a registry the guard refuses", async () => {
  // The public-only guard refuses the local registry before any request.
  const lookups = await lookUpDomains(["example.test"], {
    guard,
    bootstrapUrl: `${origin}/dns.json`,
  });
  expect(lookups.get("example.test")).toEqual({ status: "failed" });
});
