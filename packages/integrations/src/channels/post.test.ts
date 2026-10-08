import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createGuard, guard } from "../net/ssrf.ts";
import { isRetryable, postJson } from "./post.ts";

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
