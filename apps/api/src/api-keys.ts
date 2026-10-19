import { createHash, randomBytes } from "node:crypto";

// API keys for scripts. A key is 32 random bytes, so its plain SHA-256 is safe to look it up by;
// nothing else about it is stored, and it is shown once.

/** What every key looks like: anything else is refused before the database is asked. */
export const isApiKey = (key: string) => /^gln_[A-Za-z0-9_-]{43}$/.test(key);

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key, its first characters (to tell keys apart in a list) and the hash to keep. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `gln_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}
