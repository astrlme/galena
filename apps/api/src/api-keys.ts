import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type AppKeys, keyedHash } from "@galena/integrations/secrets";

// API keys for scripts: 24 random bytes and a tag keyed with the deployment's app key, so a key
// this deployment didn't make is refused before the database is asked (a made-up one can't wake
// a paused cluster). Only the key's SHA-256 is stored, and it is shown once.

const tagOf = (keys: AppKeys, random: string) => keyedHash(keys, `api-key:${random}`);

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key, its first characters (to tell keys apart in a list) and the hash to keep. */
export function newApiKey(keys: AppKeys): { key: string; prefix: string; hash: string } {
  const random = randomBytes(24).toString("base64url");
  const key = `gln_${random}${tagOf(keys, random)}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

/** Whether this deployment made `key`: the right shape, and a tag that matches. */
export function isApiKey(keys: AppKeys, key: string): boolean {
  const parts = /^gln_([A-Za-z0-9_-]{32})([A-Za-z0-9_-]{22})$/.exec(key);
  if (!parts) return false;
  const [given, expected] = [Buffer.from(parts[2] ?? ""), Buffer.from(tagOf(keys, parts[1] ?? ""))];
  return given.length === expected.length && timingSafeEqual(given, expected);
}
