import { type ClientRequest, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { CheckErrorCode, CheckResult, HttpCheck } from "@galena/contracts";
import { BlockedByGuardError, guard as defaultGuard, type Guard } from "./ssrf.ts";

const MAX_REDIRECTS = 5;
/** Enough of the body to find a keyword; the rest is never downloaded. */
const MAX_BODY_BYTES = 1_048_576;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "Galena-Probe (+https://github.com/astrlme/galena)";

export type HttpOutcome = Pick<
  CheckResult,
  "status" | "httpStatus" | "latencyMs" | "phases" | "error"
>;
type Phases = NonNullable<CheckResult["phases"]>;
type Sent =
  | { ok: true; status: number; location: string | undefined; body: string; phases: Phases }
  | { ok: false; code: CheckErrorCode; message: string };

/**
 * One HTTP check, redirects included, each hop through the SSRF guard. Never throws; messages
 * never repeat the URL or a Location header, which can carry tokens.
 */
export async function checkHttp(
  check: HttpCheck,
  guard: Guard = defaultGuard,
): Promise<HttpOutcome> {
  const signal = AbortSignal.timeout(check.timeoutMs);
  const started = performance.now();
  const latencyMs = () => Math.round(performance.now() - started);
  const down = (code: CheckErrorCode, message: string, httpStatus: number | null = null) => ({
    status: "down" as const,
    httpStatus,
    latencyMs: httpStatus === null ? null : latencyMs(),
    phases: null,
    error: { code, message },
  });

  let url = guard.checkUrl(check.url);
  for (let redirects = 0; ; redirects++) {
    if (!url.ok) return down("blocked_by_guard", url.error.message);
    const sent = await send(url.value, check, guard, signal);
    if (!sent.ok) {
      if (sent.code !== "probe_failed") return down(sent.code, sent.message);
      return { status: "error", httpStatus: null, latencyMs: null, phases: null, error: sent };
    }
    if (check.followRedirects && REDIRECTS.has(sent.status) && sent.location !== undefined) {
      if (redirects === MAX_REDIRECTS) {
        return down("http_status", `Stopped after ${MAX_REDIRECTS} redirects.`, sent.status);
      }
      url = guard.checkUrl(sent.location, url.value.href);
      continue;
    }

    const result = { httpStatus: sent.status, latencyMs: latencyMs(), phases: sent.phases };
    const accepted = check.expectedStatus
      ? check.expectedStatus.includes(sent.status)
      : sent.status >= 200 && sent.status < 300;
    if (!accepted) {
      const expected = check.expectedStatus?.join(", ") ?? "a 2xx status";
      const message = `Expected ${expected}, got ${sent.status}.`;
      return { ...result, status: "down", error: { code: "http_status", message } };
    }
    if (check.keyword !== undefined && !sent.body.includes(check.keyword)) {
      const message = `The response doesn't contain "${check.keyword}".`;
      return { ...result, status: "down", error: { code: "keyword_missing", message } };
    }
    return { ...result, status: "up", error: null };
  }
}

/** One request on a fresh connection, timed from socket events. */
function send(url: URL, check: HttpCheck, guard: Guard, signal: AbortSignal): Promise<Sent> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const start = performance.now();
    const at: { dns?: number; connect?: number; tls?: number; ttfb?: number } = {};
    const since = (from: number, to: number | undefined) =>
      Math.max(0, Math.round((to ?? from) - from));

    const fail = (error: unknown) => resolve({ ok: false, ...classify(error) });
    function classify(error: unknown): { code: CheckErrorCode; message: string } {
      if (signal.aborted) {
        return { code: "timeout", message: `No complete response within ${check.timeoutMs} ms.` };
      }
      if (error instanceof BlockedByGuardError) {
        return { code: "blocked_by_guard", message: error.message };
      }
      const code = (error as { code?: unknown }).code;
      const detail = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
      if (at.connect === undefined) {
        return at.dns === undefined && !isIP(url.hostname.replace(/^\[(.*)\]$/, "$1"))
          ? { code: "dns_failed", message: `The host name didn't resolve${detail}.` }
          : { code: "connection_failed", message: `Couldn't connect to the host${detail}.` };
      }
      if (isHttps && at.tls === undefined) {
        return { code: "tls_failed", message: `The TLS handshake failed${detail}.` };
      }
      return { code: "connection_failed", message: `The connection broke off${detail}.` };
    }

    // Timed here rather than from the socket's `lookup` event, which a fast resolver can
    // emit before the request hands the socket over.
    const lookup: LookupFunction = (hostname, options, callback) =>
      guard.lookup(hostname, options, (error, address, family) => {
        if (!error) at.dns = performance.now();
        callback(error, address, family);
      });

    let req: ClientRequest;
    try {
      req = (isHttps ? httpsRequest : httpRequest)(url, {
        method: check.method,
        agent: false,
        lookup,
        signal,
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
      });
    } catch {
      // Only our own options can make the request throw, so this is a probe bug.
      return resolve({
        ok: false,
        code: "probe_failed",
        message: "The probe couldn't build the request.",
      });
    }
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        at.connect = performance.now();
      });
      socket.once("secureConnect", () => {
        at.tls = performance.now();
      });
    });
    req.on("error", fail);
    req.on("response", (response) => {
      at.ttfb = performance.now();
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        const dnsDone = at.dns ?? start; // an IP literal skips the lookup
        const connected = at.connect ?? dnsDone;
        const secured = at.tls ?? connected;
        resolve({
          ok: true,
          status: response.statusCode ?? 0,
          location: response.headers.location,
          body: Buffer.concat(chunks).toString("utf8"),
          phases: {
            dns: since(start, at.dns),
            connect: since(dnsDone, at.connect),
            tls: isHttps ? since(connected, at.tls) : null,
            ttfb: since(secured, at.ttfb),
            total: since(start, performance.now()),
          },
        });
      };
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (check.keyword !== undefined) chunks.push(chunk);
        if (size >= MAX_BODY_BYTES) {
          finish();
          req.destroy();
        }
      });
      response.on("end", finish);
      // Without `end`, the body was cut short; after `end` this is a no-op.
      response.on("close", () => fail(new Error("closed")));
      response.on("error", fail);
    });
    req.end();
  });
}
