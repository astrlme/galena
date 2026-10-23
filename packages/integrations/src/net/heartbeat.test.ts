import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { heartbeat } from "./heartbeat.ts";
import { createGuard } from "./ssrf.ts";

let base = "";
const received: { method: string | undefined; url: string | undefined }[] = [];
const server = createServer((req, res) => {
  received.push({ method: req.method, url: req.url });
  res.statusCode = req.url === "/gone" ? 404 : req.url === "/busy" ? 429 : 200;
  res.end("OK");
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  received.length = 0;
});

// The test server is on loopback, which only this guard allows.
const local = createGuard({ allowAddresses: ["127.0.0.1"] });

/** A loopback URL whose port just closed, so connecting is refused. */
async function closedPort() {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  return `http://127.0.0.1:${port}/ping`;
}

test("pings the URL with a GET", async () => {
  const failures: unknown[] = [];
  const beat = heartbeat({
    url: `${base}/ping/abc`,
    guard: local,
    now: () => 0,
    onFailure: (cause) => failures.push(cause),
  });
  await beat();
  expect(received).toEqual([{ method: "GET", url: "/ping/abc" }]);
  expect(failures).toEqual([]);
});

test("does nothing without a URL", async () => {
  const failures: unknown[] = [];
  await heartbeat({
    url: undefined,
    guard: local,
    now: () => 0,
    onFailure: (cause) => failures.push(cause),
  })();
  expect(received).toEqual([]);
  expect(failures).toEqual([]);
});

test("pings at most once a minute", async () => {
  let now = 1_000_000;
  const beat = heartbeat({
    url: `${base}/ping`,
    guard: local,
    now: () => now,
    onFailure: () => {},
  });
  await beat();
  now += 59_999;
  await beat();
  expect(received).toHaveLength(1);
  now += 1;
  await beat();
  expect(received).toHaveLength(2);
});

test("reports a failed ping instead of throwing", async () => {
  const failures: unknown[] = [];
  const onFailure = (cause: unknown) => failures.push(cause);
  const ping = (url: string, guard = local) => heartbeat({ url, guard, now: () => 0, onFailure })();

  await expect(ping(`${base}/gone`)).resolves.toBeUndefined();
  // Loopback, which the production guard refuses before any request.
  await expect(ping(`${base}/ping`, createGuard())).resolves.toBeUndefined();
  await expect(ping(await closedPort())).resolves.toBeUndefined();
  // Rate limited: another container's ping this minute counts.
  await expect(ping(`${base}/busy`)).resolves.toBeUndefined();

  expect(failures).toEqual([
    { status: 404 },
    { error: "BlockedByGuardError" },
    { error: "Error", code: "ECONNREFUSED" },
  ]);
});
