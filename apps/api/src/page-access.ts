import { createSign } from "node:crypto";
import { generateCookie } from "hono/cookie";

/** Where the internal view is served on the dashboard's origin, behind CloudFront's key group. */
export const PAGE_PATH = "/internal";

export const PAGE_COOKIES = [
  "CloudFront-Policy",
  "CloudFront-Signature",
  "CloudFront-Key-Pair-Id",
  "CloudFront-Hash-Algorithm",
] as const;

/**
 * Sent only to the internal page, never readable by a script, and along with a link from Slack
 * or an email. Session cookies: the policy inside says when access ends.
 */
export const PAGE_COOKIE = {
  path: PAGE_PATH,
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
} as const;

/** Expired copies of the cookies, for sign-out: the browser drops them at once. */
export const expiredPageCookies = PAGE_COOKIES.map((name) =>
  generateCookie(name, "", { ...PAGE_COOKIE, maxAge: 0 }),
);

/** Base64 in CloudFront's alphabet: `+`, `=` and `/` become `-`, `_` and `~`. */
const cloudfront = (base64: string) =>
  base64.replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");

/**
 * CloudFront's signed cookies for a custom policy: the internal view, and nothing else on the
 * origin, until `expires`. Signed with SHA-256, which CloudFront reads from the hash cookie.
 */
export function signedCookies(input: {
  origin: string;
  expires: Date;
  keyPairId: string;
  privateKey: string;
}): Record<(typeof PAGE_COOKIES)[number], string> {
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${new URL(input.origin).origin}${PAGE_PATH}*`,
        Condition: {
          DateLessThan: { "AWS:EpochTime": Math.floor(input.expires.getTime() / 1000) },
        },
      },
    ],
  });
  return {
    "CloudFront-Policy": cloudfront(Buffer.from(policy).toString("base64")),
    "CloudFront-Signature": cloudfront(
      createSign("sha256").update(policy).sign(input.privateKey, "base64"),
    ),
    "CloudFront-Key-Pair-Id": input.keyPairId,
    "CloudFront-Hash-Algorithm": "SHA256",
  };
}
