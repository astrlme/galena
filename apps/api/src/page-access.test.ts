import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { PAGE_COOKIES, signedCookies } from "./page-access.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const decode = (value: string) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");

test("signs CloudFront's policy for the internal page until it expires, with SHA-256", () => {
  const cookies = signedCookies({
    origin: "https://dashboard.example.com",
    expires: new Date("2026-10-28T10:00:00.000Z"),
    keyPairId: "K2JCJMDEHXQW5F",
    privateKey,
  });
  expect(Object.keys(cookies)).toEqual(PAGE_COOKIES);
  // No whitespace: CloudFront checks the signature over these exact bytes.
  const policy = decode(cookies["CloudFront-Policy"]).toString();
  expect(policy).toBe(
    '{"Statement":[{"Resource":"https://dashboard.example.com/internal*","Condition":{"DateLessThan":{"AWS:EpochTime":1793181600}}}]}',
  );
  const signature = decode(cookies["CloudFront-Signature"]);
  expect(createVerify("sha256").update(policy).verify(publicKey, signature)).toBe(true);
  expect(cookies["CloudFront-Key-Pair-Id"]).toBe("K2JCJMDEHXQW5F");
  expect(cookies["CloudFront-Hash-Algorithm"]).toBe("SHA256");
  // CloudFront's alphabet only, so no value needs escaping in a cookie.
  for (const value of Object.values(cookies)) expect(value).toMatch(/^[A-Za-z0-9_~-]+$/);
});
