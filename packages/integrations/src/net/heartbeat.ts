import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockedByGuardError, type Guard, guard as publicOnly } from "./ssrf.ts";

// Healthchecks asks for no more than five pings a minute per check; the evaluator runs several
// times a minute, the jobs heartbeat once an hour.
const EVERY_MS = 60_000;

/** GETs `url` through the guard and resolves to the status. 5 s at most: the evaluator waits on it. */
function ping(url: string, guard: Guard): Promise<number> {
  const checked = guard.checkUrl(url);
  if (!checked.ok) return Promise.reject(new BlockedByGuardError(checked.error.message));
  const send = checked.value.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(checked.value, {
      method: "GET",
      agent: false,
      lookup: guard.lookup,
      signal: AbortSignal.timeout(5_000),
    });
    req.on("error", reject);
    req.on("response", (response) => {
      response.resume(); // the body says nothing we act on
      resolve(response.statusCode ?? 0);
    });
    req.end();
  });
}

/** Why a ping failed, safe to log: never the URL or an error's message, which can name the host. */
export type PingFailure = { status: number } | { error: string; code?: string };

const failure = (error: unknown): PingFailure => {
  if (!(error instanceof Error)) return { error: typeof error };
  const { code } = error as { code?: unknown };
  return { error: error.name, ...(typeof code === "string" ? { code } : {}) };
};

/**
 * Tells an outside dead-man's switch (Healthchecks or any service that takes a ping URL) that
 * this part of the deployment still runs; the service emails the operator when the pings stop,
 * even if this AWS account can't. At most one GET a minute, and never a throw: the work the ping
 * follows has already succeeded, so a failed ping only goes to `onFailure`. Without a URL it does
 * nothing. The URL is the operator's secret: anyone holding it can keep the check quiet, so it is
 * never logged.
 */
export function heartbeat(input: {
  url: string | undefined;
  onFailure: (reason: PingFailure) => void;
  guard?: Guard;
  now?: () => number;
}): () => Promise<void> {
  const { guard = publicOnly, now = Date.now } = input;
  let last: number | undefined;
  return async () => {
    if (!input.url) return;
    const at = now();
    if (last !== undefined && at - last < EVERY_MS) return;
    last = at;
    try {
      const status = await ping(input.url, guard);
      // 429: another container pinged this minute, and that ping counts.
      if ((status < 200 || status > 299) && status !== 429) input.onFailure({ status });
    } catch (error) {
      input.onFailure(failure(error));
    }
  };
}
