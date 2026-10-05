import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// Seeded by `pnpm db:seed` (apps/api/src/seed.ts); local databases only.
export const OWNER = { email: "owner@example.com", password: "galena-local-owner" };

export async function expectAccessible(page: Page) {
  // A dialog fading in has text at partial opacity; check what people read once it has opened.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

export async function signIn(page: Page, password = OWNER.password) {
  await page.goto("/sign-in/");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The code an authenticator app shows now for a base32 key: RFC 6238, SHA-1, 30 s, 6 digits. */
export function totp(key: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = key
    .toUpperCase()
    .replace(/[\s=]/g, "")
    .split("")
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const secret = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
