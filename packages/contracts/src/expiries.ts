import { z } from "zod";
import { type ExpiryKind, expiryKinds } from "./enums.ts";
import { monitorId, type WorkspaceId } from "./ids.ts";

// Certificates and domains that expire: the probe reads a certificate at each HTTPS check, and
// the hourly expiry scan looks domains up over RDAP.

/** The leaf certificate a check's TLS handshake got; with redirects, the one expiring first. */
export const tlsCertificate = z.object({
  host: z.string().min(1).max(253),
  validTo: z.iso.datetime(),
  /** The issuer's organisation, or its common name without one. */
  issuer: z.string().max(200),
});
export type TlsCertificate = z.infer<typeof tlsCertificate>;

/** Days before an expiry when members are warned, most urgent last. */
export const EXPIRY_THRESHOLDS = [30, 14, 7] as const;
export type ExpiryThreshold = (typeof EXPIRY_THRESHOLDS)[number];

/** The last warning members got about an expiry, and the expiry date it was about. */
export const sentWarning = z.object({
  expiresAt: z.iso.datetime(),
  threshold: z.literal(EXPIRY_THRESHOLDS),
});
export type SentWarning = z.infer<typeof sentWarning>;

/** One certificate (by host) or registered domain, and the monitors that reach it. */
export const expiry = z.object({
  kind: z.enum(expiryKinds),
  /** The certificate's host, or the registered domain. */
  name: z.string().min(1).max(253),
  /** Null for a domain whose registry publishes no expiry date over RDAP. */
  expiresAt: z.iso.datetime().nullable(),
  /** A certificate's issuer; null for a domain. */
  issuer: z.string().max(200).nullable(),
  monitorIds: z.array(monitorId),
  checkedAt: z.iso.datetime(),
});
export type Expiry = z.infer<typeof expiry>;

export const expiryList = z.object({ expiries: z.array(expiry) });

/** An expiry's key in its partition, and in lists: `certificate#api.example.com`. */
export const expiryKey = (e: Pick<Expiry, "kind" | "name">) => `${e.kind}#${e.name}`;

/** What expires, as members read it: "Certificate for api.example.com", "Domain example.com". */
export const expirySubjects: Record<ExpiryKind, (name: string) => string> = {
  certificate: (name) => `Certificate for ${name}`,
  domain: (name) => `Domain ${name}`,
};

/** The telemetry table's partition of one workspace's expiries, one item per `{kind}#{name}`. */
export const expiryPartition = (workspaceId: WorkspaceId) => `EXPIRY#${workspaceId}`;

/** An expiry as the scan stores it, with the last warning members got about it. */
export const storedExpiry = expiry.extend({ sent: sentWarning.nullable().default(null) });
export type StoredExpiry = z.infer<typeof storedExpiry>;

/** IANA's RDAP bootstrap file for domains (RFC 9224): `[tlds, base URLs]` pairs. */
export const rdapBootstrap = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

/** The part of an RDAP domain reply the scan reads (RFC 9083): its events, expiry among them. */
export const rdapDomain = z.object({
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).default([]),
});
