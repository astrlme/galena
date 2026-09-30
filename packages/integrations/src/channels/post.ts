import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockedByGuardError, type Guard } from "../net/ssrf.ts";

const USER_AGENT = "Galena-Webhooks/1 (+https://github.com/astrlme/galena)";

/**
 * POSTs JSON to a member's endpoint through the SSRF guard: the URL is checked, and every DNS
 * answer too, so a host can't point at a private address after the check. 8 s at most.
 */
export function postJson(input: {
  url: string;
  body: string;
  headers?: Record<string, string>;
  guard: Guard;
  timeoutMs?: number;
}): Promise<{ status: number }> {
  const checked = input.guard.checkUrl(input.url);
  if (!checked.ok) return Promise.reject(new BlockedByGuardError(checked.error.message));
  const url = checked.value;
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: "POST",
      agent: false,
      lookup: input.guard.lookup,
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        ...input.headers,
      },
    });
    req.on("error", reject);
    req.on("response", (response) => {
      response.resume(); // the body says nothing we act on
      resolve({ status: response.statusCode ?? 0 });
    });
    req.end(input.body);
  });
}

/** Worth another try: rate limited or the receiver failing. Other 4xx won't change. */
export const isRetryable = (status: number) => status === 429 || status >= 500;
