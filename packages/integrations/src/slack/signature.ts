import { createHmac, timingSafeEqual } from "node:crypto";

// Slack signs every request it sends with the app's signing secret: `X-Slack-Signature` is
// `v0=` + hex HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{raw body}`.
const MAX_AGE_SECONDS = 5 * 60;

/** Whether Slack sent this request recently: a matching signature over the exact raw body. */
export function verifySlackSignature(
  signingSecret: string,
  request: { timestamp: string | undefined; signature: string | undefined; rawBody: string },
  now: Date,
): boolean {
  const { timestamp, signature, rawBody } = request;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  // A captured request can't be replayed later: its timestamp is part of what's signed.
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
