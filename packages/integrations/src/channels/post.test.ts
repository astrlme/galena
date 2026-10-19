import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BlockedByGuardError, createGuard, guard } from "../net/ssrf.ts";
import { isFinalSendError, isRetryable, postJson, postToEndpoint } from "./post.ts";

let url = "";
const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    if (req.url === "/answer") {
      res.setHeader("content-type", "application/json");
      return res.end('{"ok":true}');
    }
    res.statusCode = req.url === "/busy" ? 503 : 204;
    res.end();
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

// The test server is on loopback, which only this guard allows.
const local = createGuard({ allowAddresses: ["127.0.0.1"] });

test("posts the body and headers, and reports the status", async () => {
  expect(
    await postJson({
      url: `${url}/hook`,
      body: '{"a":1}',
      headers: { "webhook-id": "m1" },
      guard: local,
    }),
  ).toEqual({ status: 204 });
  expect(received.at(-1)).toMatchObject({
    body: '{"a":1}',
    headers: { "content-type": "application/json", "webhook-id": "m1" },
  });
  expect(await postJson({ url: `${url}/busy`, body: "{}", guard: local })).toEqual({ status: 503 });
});

test("reads the answer only when asked", async () => {
  expect(await postJson({ url: `${url}/answer`, body: "{}", guard: local })).toEqual({
    status: 200,
  });
  expect(
    await postJson({ url: `${url}/answer`, body: "{}", guard: local, readBody: true }),
  ).toEqual({ status: 200, body: '{"ok":true}' });
});

test("refuses private addresses with the default guard", async () => {
  await expect(postJson({ url: `${url}/hook`, body: "{}", guard })).rejects.toThrow();
  await expect(
    postJson({ url: "http://169.254.169.254/latest", body: "{}", guard }),
  ).rejects.toThrow();
});

test("retries rate limits and server errors only", () => {
  expect([429, 500, 503].map(isRetryable)).toEqual([true, true, true]);
  expect([400, 403, 404, 410].map(isRetryable)).toEqual([false, false, false, false]);
});

test("only the guard's refusal ends a send; anything that may pass is retried", () => {
  expect(isFinalSendError(new BlockedByGuardError("Private and reserved addresses…"))).toBe(true);
  const resuming = Object.assign(new Error("resuming"), { name: "DatabaseResumingException" });
  for (const error of [
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    resuming,
    new Error("socket hang up"),
    "a string",
  ]) {
    expect(isFinalSendError(error)).toBe(false);
  }
});

test("says how a send went instead of throwing for the receiver", async () => {
  const local = createGuard({ allowAddresses: ["127.0.0.1"] });
  const send = (path: string, g = local) =>
    postToEndpoint({ url: `${url}${path}`, body: "{}", guard: g });
  expect(await send("/ok")).toEqual({ ok: true, status: 204 });
  expect(await send("/busy")).toEqual({
    ok: false,
    status: 503,
    error: "The endpoint answered HTTP 503.",
    retryable: true,
  });
  expect(await send("/ok", guard)).toMatchObject({ ok: false, status: 0, retryable: false });
});
