import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { err, ok, type Result } from "@galena/core";

// Every outbound URL passes here: probe checks, webhook sends, importers. A URL is checked
// before the request, and every address DNS returns is checked again as the socket connects.
// The socket only ever gets addresses that passed, so a name can't be re-pointed somewhere
// private between the check and the connection (DNS rebinding).

const blocked = new BlockList();
// IANA special-purpose ranges: nothing a public check should ever reach.
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the instance metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
// IPv4-mapped addresses (::ffff:10.0.0.1) are matched against the IPv4 ranges by BlockList.
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ["64:ff9b::", 96], // NAT64 reaches IPv4, private ranges included
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 embeds an IPv4 address
  ["fc00::", 7], // unique local, including EC2's fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Raised from `lookup`, so it reaches the request's error handler as the cause. */
export class BlockedByGuardError extends Error {
  override name = "BlockedByGuardError";
}

type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type Guard = {
  /** Scheme, credentials and IP-literal checks, before any request. */
  checkUrl(input: string, base?: string): Result<URL, "blocked_by_guard">;
  /** The `lookup` for node:http and node:net: refuses a name with any private answer. */
  lookup: LookupFunction;
};

const PRIVATE = "Private and reserved addresses are never checked.";

/** `allowAddresses` exists for tests against a local server; production uses `guard`. */
export function createGuard(
  options: { allowAddresses?: readonly string[]; resolve?: Resolve } = {},
): Guard {
  const allowed = new Set(options.allowAddresses);
  const resolve = options.resolve ?? dnsLookup;
  const isAllowed = (address: string) => allowed.has(address) || isPublicAddress(address);

  return {
    checkUrl(input, base) {
      const url = URL.parse(input, base);
      if (!url) return err("blocked_by_guard", "This isn't a valid URL.");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return err("blocked_by_guard", "Only http:// and https:// URLs can be checked.");
      }
      if (url.username || url.password) {
        return err("blocked_by_guard", "URLs with credentials are refused.");
      }
      // The URL parser has already turned 2130706433 and 0x7f.1 into dotted form.
      const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
      if (isIP(host) && !isAllowed(host)) return err("blocked_by_guard", PRIVATE);
      return ok(url);
    },

    lookup(hostname, lookupOptions, callback) {
      resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
        if (error) return callback(error, []);
        const [first] = addresses;
        if (!first || !addresses.every((a) => isAllowed(a.address))) {
          return callback(new BlockedByGuardError(PRIVATE), []);
        }
        if (lookupOptions.all) return callback(null, addresses);
        callback(null, first.address, first.family);
      });
    },
  };
}

export const guard = createGuard();
