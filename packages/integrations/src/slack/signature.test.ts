import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { verifySlackSignature } from "./signature.ts";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const now = new Date("2026-10-08T12:00:00Z");
const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));
const sign = (timestamp: string, body: string, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${body}`).digest("hex")}`;
const body = "token=x&team_id=T1&command=%2Fincident&response_url=https%3A%2F%2Fhooks.slack.com";

test("accepts a request Slack signed in the last five minutes", () => {
  const timestamp = seconds(new Date(now.getTime() - 60_000));
  expect(
    verifySlackSignature(
      secret,
      { timestamp, signature: sign(timestamp, body), rawBody: body },
      now,
    ),
  ).toBe(true);
});

test("refuses a signature made with another secret or over another body", () => {
  const timestamp = seconds(now);
  const forged = sign(timestamp, body, "not-the-signing-secret");
  expect(verifySlackSignature(secret, { timestamp, signature: forged, rawBody: body }, now)).toBe(
    false,
  );
  const signature = sign(timestamp, body);
  expect(
    verifySlackSignature(secret, { timestamp, signature, rawBody: `${body}&user_id=U2` }, now),
  ).toBe(false);
});

test("refuses a request older than five minutes, even when the signature matches", () => {
  const timestamp = seconds(new Date(now.getTime() - 301_000));
  expect(
    verifySlackSignature(
      secret,
      { timestamp, signature: sign(timestamp, body), rawBody: body },
      now,
    ),
  ).toBe(false);
});

test("refuses a captured body replayed under a fresh timestamp", () => {
  const old = seconds(new Date(now.getTime() - 600_000));
  const signature = sign(old, body);
  expect(
    verifySlackSignature(secret, { timestamp: seconds(now), signature, rawBody: body }, now),
  ).toBe(false);
});

test("refuses missing or malformed headers", () => {
  const timestamp = seconds(now);
  for (const request of [
    { timestamp: undefined, signature: sign(timestamp, body), rawBody: body },
    { timestamp, signature: undefined, rawBody: body },
    { timestamp: "12ab", signature: sign("12ab", body), rawBody: body },
    { timestamp, signature: "v0=short", rawBody: body },
  ]) {
    expect(verifySlackSignature(secret, request, now)).toBe(false);
  }
});
