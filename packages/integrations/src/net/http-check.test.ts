import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type HttpCheck, httpCheck } from "@galena/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHttp } from "./http-check.ts";
import { createGuard, guard } from "./ssrf.ts";

// A local server stands in for the target. Only this test guard may reach 127.0.0.1, and its
// resolver maps *.test names without touching real DNS.
const paths: string[] = [];
let server: Server;
let origin: string;

const names: Record<string, string> = { "local.test": "127.0.0.1", "private.test": "10.0.0.7" };
const testGuard = createGuard({
  allowAddresses: ["127.0.0.1"],
  resolve: (hostname, _options, callback) => {
    const address = names[hostname];
    if (!address) {
      return callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    }
    callback(null, [{ address, family: 4 }]);
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    paths.push(url.pathname);
    if (url.pathname === "/ok") return res.end("all systems operational");
    if (url.pathname === "/status/503") return res.writeHead(503).end();
    if (url.pathname === "/redirect") {
      return res.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end();
    }
    if (url.pathname === "/loop") return res.writeHead(301, { location: "/loop" }).end();
    if (url.pathname === "/hang") return; // never answers
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://local.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const check = (url: string, overrides: Partial<HttpCheck> = {}): HttpCheck => ({
  ...httpCheck.parse({ url }),
  ...overrides,
});

describe("checkHttp", () => {
  test("a 2xx is up, with phase timings and no TLS phase over http", async () => {
    const outcome = await checkHttp(check(`${origin}/ok`), testGuard);
    expect(outcome).toMatchObject({ status: "up", httpStatus: 200, error: null });
    expect(outcome.phases).toMatchObject({ tls: null });
    expect(outcome.phases?.total).toBeGreaterThanOrEqual(outcome.phases?.ttfb ?? 0);
  });

  test("a status outside the expected ones is down", async () => {
    expect(await checkHttp(check(`${origin}/status/503`), testGuard)).toMatchObject({
      status: "down",
      httpStatus: 503,
      error: { code: "http_status", message: "Expected a 2xx status, got 503." },
    });
    const expected503 = check(`${origin}/status/503`, { expectedStatus: [503] });
    expect(await checkHttp(expected503, testGuard)).toMatchObject({ status: "up" });
  });

  test("a missing keyword is down; a present one is up", async () => {
    const found = check(`${origin}/ok`, { keyword: "operational" });
    expect(await checkHttp(found, testGuard)).toMatchObject({ status: "up" });
    const missing = check(`${origin}/ok`, { keyword: "degraded" });
    expect(await checkHttp(missing, testGuard)).toMatchObject({
      status: "down",
      httpStatus: 200,
      error: { code: "keyword_missing" },
    });
  });

  test("follows redirects, or reports the redirect when told not to", async () => {
    const url = `${origin}/redirect?to=/ok`;
    expect(await checkHttp(check(url), testGuard)).toMatchObject({ status: "up", httpStatus: 200 });
    expect(await checkHttp(check(url, { followRedirects: false }), testGuard)).toMatchObject({
      status: "down",
      httpStatus: 302,
      error: { code: "http_status" },
    });
  });

  test.each([
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://private.test/",
    "file:///etc/passwd",
  ])("refuses a redirect to %s", async (to) => {
    const outcome = await checkHttp(
      check(`${origin}/redirect?to=${encodeURIComponent(to)}`),
      testGuard,
    );
    expect(outcome).toMatchObject({ status: "down", error: { code: "blocked_by_guard" } });
  });

  test("stops after five redirects", async () => {
    paths.length = 0;
    expect(await checkHttp(check(`${origin}/loop`), testGuard)).toMatchObject({
      status: "down",
      error: { code: "http_status", message: "Stopped after 5 redirects." },
    });
    expect(paths).toHaveLength(6);
  });

  test("the production guard never connects to loopback, by address or by name", async () => {
    const port = (server.address() as AddressInfo).port;
    paths.length = 0;
    for (const url of [`http://127.0.0.1:${port}/ok`, `http://localhost:${port}/ok`]) {
      expect(await checkHttp(check(url), guard)).toMatchObject({
        status: "down",
        error: { code: "blocked_by_guard" },
      });
    }
    expect(paths).toEqual([]);
  });

  test("a name that doesn't resolve is dns_failed", async () => {
    expect(await checkHttp(check("http://missing.test/"), testGuard)).toMatchObject({
      status: "down",
      error: { code: "dns_failed", message: "The host name didn't resolve (ENOTFOUND)." },
    });
  });

  test("a closed port is connection_failed", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await checkHttp(check(`http://local.test:${port}/`), testGuard)).toMatchObject({
      status: "down",
      error: { code: "connection_failed" },
    });
  });

  test("https against a plain-http server is tls_failed", async () => {
    const url = `${origin.replace("http:", "https:")}/ok`;
    expect(await checkHttp(check(url), testGuard)).toMatchObject({
      status: "down",
      error: { code: "tls_failed" },
    });
  });

  test("no response within timeoutMs is a timeout", async () => {
    expect(await checkHttp(check(`${origin}/hang`, { timeoutMs: 300 }), testGuard)).toMatchObject({
      status: "down",
      latencyMs: null,
      error: { code: "timeout", message: "No complete response within 300 ms." },
    });
  });
});
