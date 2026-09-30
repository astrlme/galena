import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { appKeys, keyedHash, linkToken, open, readLinkToken, seal } from "./keys.ts";

const keys = appKeys(randomBytes(32).toString("base64"));
const other = appKeys(randomBytes(32).toString("base64"));
const subscriber = "01920000-0000-7000-8000-000000000501";
const issued = new Date("2026-09-30T12:00:00.000Z");

test("the app key must be 32 random bytes", () => {
  expect(() => appKeys(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
});

describe("seal and open", () => {
  const url = "https://hooks.slack.com/services/T000/B000/XXXXXXXX";

  test("opens what was sealed, and sealing twice gives different text", () => {
    const sealed = seal(keys, url);
    expect(sealed).not.toContain("hooks.slack.com");
    expect(seal(keys, url)).not.toBe(sealed);
    expect(open(keys, sealed)).toBe(url);
  });

  test("refuses a changed box or another deployment's key", () => {
    const sealed = seal(keys, url);
    const [version, iv, box] = sealed.split(".");
    const flipped = `${box?.[0] === "A" ? "B" : "A"}${box?.slice(1)}`;
    expect(() => open(keys, `${version}.${iv}.${flipped}`)).toThrow();
    expect(() => open(other, sealed)).toThrow();
  });
});

describe("link tokens", () => {
  test("carry the subscriber and when they were issued", () => {
    const token = linkToken(keys, "confirm", subscriber, issued);
    expect(readLinkToken(keys, "confirm", token)).toEqual({ id: subscriber, issuedAt: issued });
  });

  test("are refused for another purpose, when edited, or under another key", () => {
    const token = linkToken(keys, "unsubscribe", subscriber, issued);
    expect(readLinkToken(keys, "confirm", token)).toBeUndefined();
    expect(readLinkToken(other, "unsubscribe", token)).toBeUndefined();
    const edited = token.replace(subscriber, "01920000-0000-7000-8000-000000000502");
    expect(readLinkToken(keys, "unsubscribe", edited)).toBeUndefined();
    for (const junk of ["", "a.b", "unsubscribe.x.y.z", `${token}x`]) {
      expect(readLinkToken(keys, "unsubscribe", junk)).toBeUndefined();
    }
  });
});

test("keyed hashes are stable per key and say nothing about the input", () => {
  const hash = keyedHash(keys, "ada@example.com");
  expect(keyedHash(keys, "ada@example.com")).toBe(hash);
  expect(keyedHash(other, "ada@example.com")).not.toBe(hash);
  expect(hash).toMatch(/^[\w-]{22}$/);
});
