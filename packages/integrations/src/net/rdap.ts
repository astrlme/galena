import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { rdapBootstrap, rdapDomain } from "@galena/contracts";
import { getDomain } from "tldts-icann";
import { BlockedByGuardError, type Guard, guard as publicOnly } from "./ssrf.ts";

/** IANA's list of each top-level domain's RDAP servers (RFC 9224). */
export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const TIMEOUT_MS = 8_000;
/** The bootstrap file is about 70 KB and a domain reply a few KB. */
const MAX_BYTES = 1_048_576;
/** Lookups at once, so one slow registry doesn't hold up the rest for long. */
const CONCURRENCY = 4;

/**
 * The domain someone registered for `host`, by the ICANN part of the Public Suffix List
 * (`api.example.co.uk` → `example.co.uk`); null for an IP address or a bare name.
 */
export function registeredDomain(host: string): string | null {
  return getDomain(host);
}

/**
 * A domain's expiry as its registry states it: null when the registry has no RDAP server or
 * publishes no expiry date. `failed` when the lookup itself broke, so the caller keeps what it
 * knew and tries again later.
 */
export type DomainLookup = { status: "found"; expiresAt: string | null } | { status: "failed" };

/** GETs JSON through the guard, refusing a redirect, an error status or an oversized body. */
function getJson(url: string, accept: string, guard: Guard): Promise<unknown> {
  const checked = guard.checkUrl(url);
  if (!checked.ok) return Promise.reject(new BlockedByGuardError(checked.error.message));
  const send = checked.value.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(checked.value, {
      method: "GET",
      agent: false,
      lookup: guard.lookup,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept },
    });
    req.on("error", reject);
    req.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.resume();
        return reject(Object.assign(new Error("RDAP status"), { status }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) return req.destroy(new Error("RDAP reply too large"));
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    req.end();
  });
}

/**
 * Looks each registered domain up over RDAP: IANA's bootstrap once, then each domain at its
 * registry. A registry that answers 404 has no such domain, which reads as no expiry date.
 */
export async function lookUpDomains(
  domains: readonly string[],
  options: { guard?: Guard; bootstrapUrl?: string } = {},
): Promise<Map<string, DomainLookup>> {
  const guard = options.guard ?? publicOnly;
  const lookups = new Map<string, DomainLookup>();
  if (domains.length === 0) return lookups;

  let servers: [string[], string[]][];
  try {
    const list = await getJson(
      options.bootstrapUrl ?? RDAP_BOOTSTRAP_URL,
      "application/json",
      guard,
    );
    servers = rdapBootstrap.parse(list).services;
  } catch {
    for (const domain of domains) lookups.set(domain, { status: "failed" });
    return lookups;
  }

  const lookUp = async (domain: string): Promise<DomainLookup> => {
    const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
    // RFC 9224 asks clients to prefer HTTPS; a few registries list plain HTTP as well.
    const urls = servers.find(([tlds]) => tlds.includes(tld))?.[1] ?? [];
    const base = urls.find((url) => url.startsWith("https://")) ?? urls[0];
    if (!base) return { status: "found", expiresAt: null };
    try {
      const url = `${base.endsWith("/") ? base : `${base}/`}domain/${encodeURIComponent(domain)}`;
      const reply = rdapDomain.parse(await getJson(url, "application/rdap+json", guard));
      const date = reply.events.find((event) => event.eventAction === "expiration")?.eventDate;
      const expiresAt = date === undefined ? Number.NaN : Date.parse(date);
      return {
        status: "found",
        expiresAt: Number.isNaN(expiresAt) ? null : new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) {
        return { status: "found", expiresAt: null };
      }
      return { status: "failed" };
    }
  };

  for (let i = 0; i < domains.length; i += CONCURRENCY) {
    const batch = domains.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (domain) => [domain, await lookUp(domain)] as const),
    );
    for (const [domain, lookup] of results) lookups.set(domain, lookup);
  }
  return lookups;
}
