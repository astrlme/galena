import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// One app key per deployment (32 random bytes: SSM for the API, a trigger.dev secret for the
// workers). Each use gets its own key derived from it, so none can stand in for another.

export type AppKeys = { seal: Buffer; link: Buffer; hash: Buffer };

/** Local development only, so the API and the workers agree without setup. Never used in AWS. */
export const LOCAL_APP_KEY = Buffer.from("galena-local-development-app-key").toString("base64");

export function appKeys(appKey: string): AppKeys {
  const material = Buffer.from(appKey, "base64");
  if (material.length !== 32) throw new Error("The app key must be 32 bytes, base64-encoded.");
  const derive = (use: string) =>
    Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), `galena ${use} v1`, 32));
  return { seal: derive("seal"), link: derive("link"), hash: derive("hash") };
}

const b64 = (b: Buffer) => b.toString("base64url");

/** AES-256-GCM, as `v1.<iv>.<ciphertext and tag>`: for credentials kept in the database. */
export function seal(keys: AppKeys, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.seal, iv);
  const box = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `v1.${b64(iv)}.${b64(box)}`;
}

/** Throws when the text was changed or sealed under another key. */
export function open(keys: AppKeys, sealed: string): string {
  const [version, iv, box] = sealed.split(".");
  if (version !== "v1" || !iv || !box) throw new Error("Not a sealed value.");
  const bytes = Buffer.from(box, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keys.seal, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
    "utf8",
  );
}

export type LinkPurpose = "confirm" | "unsubscribe";

const mac = (keys: AppKeys, text: string) => createHmac("sha256", keys.link).update(text).digest();

/** `<purpose>.<id>.<issued, epoch seconds>.<HMAC>`: nothing about it is stored. */
export function linkToken(keys: AppKeys, purpose: LinkPurpose, id: string, issuedAt: Date): string {
  const body = `${purpose}.${id}.${Math.floor(issuedAt.getTime() / 1000)}`;
  return `${body}.${b64(mac(keys, body))}`;
}

/** The id and issue time, or undefined for a token that isn't ours or isn't for `purpose`. */
export function readLinkToken(
  keys: AppKeys,
  purpose: LinkPurpose,
  token: string,
): { id: string; issuedAt: Date } | undefined {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== purpose) return undefined;
  const [, id = "", seconds = "", signature = ""] = parts;
  const expected = mac(keys, `${purpose}.${id}.${seconds}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  if (!/^\d+$/.test(seconds)) return undefined;
  return { id, issuedAt: new Date(Number(seconds) * 1000) };
}

/** A short keyed hash, for logs and rate limits that must not hold an address or an IP. */
export function keyedHash(keys: AppKeys, value: string): string {
  return b64(createHmac("sha256", keys.hash).update(value).digest().subarray(0, 16));
}
