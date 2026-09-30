import { createHmac, randomBytes } from "node:crypto";
import type { Notice } from "@galena/contracts";

// Outgoing webhooks follow Standard Webhooks (standardwebhooks.com): the receiver checks
// webhook-signature against its copy of the secret with any of the official libraries.

/** `whsec_` and 24 random bytes, base64: the form Standard Webhooks libraries take. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** The body: `{ type, timestamp, data }`, with the notice as data. */
export function webhookBody(notice: Notice): string {
  return JSON.stringify({
    type: notice.kind.replace("_", "."),
    timestamp: notice.occurredAt,
    data: notice,
  });
}

/**
 * The three headers. `id` stays the same across retries of one delivery, so receivers can
 * de-duplicate; the signature is HMAC-SHA256 over `id.timestamp.body`.
 */
export function signWebhook(input: {
  id: string;
  body: string;
  secret: string;
  at: Date;
}): Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string> {
  const timestamp = String(Math.floor(input.at.getTime() / 1000));
  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${input.id}.${timestamp}.${input.body}`)
    .digest("base64");
  return {
    "webhook-id": input.id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}
