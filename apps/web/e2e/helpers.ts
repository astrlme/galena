import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

// Seeded by `pnpm db:seed` (apps/api/src/seed.ts); local databases only.
export const OWNER = { email: "owner@example.com", password: "galena-local-owner" };

/** A monitor's draft on the local database, written as autopilot would but with no deadline job. */
export const draft = (title: string) =>
  execSync("pnpm --filter @galena/api --silent draft:local", {
    encoding: "utf8",
    env: { ...process.env, GLN_DRAFT_TITLE: title },
  })
    .trim()
    .split("\n")
    .at(-1);

/**
 * Counts the clicks a journey takes, so a task can promise "approved in 2 clicks" and a test can
 * hold it to that. Only clicks made through `click` count.
 */
export function journey() {
  let clicks = 0;
  return {
    async click(target: Locator) {
      clicks += 1;
      await target.click();
    },
    get clicks() {
      return clicks;
    },
  };
}

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

/** Picks an option in a dashboard select: opened by its label, chosen from the list it shows. */
export async function choose(scope: Locator, label: string, option: string) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await scope.page().getByRole("option", { name: option, exact: true }).click();
}

/** Runs one of a row's actions from its menu, the button named "Actions for {name}". */
export async function rowAction(scope: Locator, name: string, action: string) {
  await scope.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await scope.page().getByRole("menuitem", { name: action, exact: true }).click();
}

/** The dashboard's section links as a person sees them: the sidebar, or behind Menu on a phone. */
export async function dashboardNav(page: Page) {
  // Below 768 px the sidebar is a drawer; the click waits for the shell to finish loading.
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole("button", { name: "Menu" }).click();
  }
  return page.getByRole("navigation", { name: "Dashboard" }).filter({ visible: true });
}

/** Opens a dashboard section from its link, at any width, then one of its parts if given. */
export async function openSection(page: Page, name: string, part?: string) {
  await (await dashboardNav(page)).getByRole("link", { name, exact: true }).click();
  if (part) {
    await page
      .getByRole("navigation", { name })
      .getByRole("link", { name: part, exact: true })
      .click();
  }
}
