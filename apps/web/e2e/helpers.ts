import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// Seeded by `pnpm db:seed` (apps/api/src/seed.ts); local databases only.
export const OWNER = { email: "owner@example.com", password: "galena-local-owner" };

export async function expectAccessible(page: Page) {
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
