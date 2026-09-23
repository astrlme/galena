import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("the landing page leads to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in/");
  await expectAccessible(page);
});

test("signed out, the dashboard sends you to sign-in", async ({ page }) => {
  await page.goto("/dashboard/");
  await expect(page).toHaveURL(/\/sign-in\/$/);
});

test("a wrong password shows an error next to the form", async ({ page }) => {
  await signIn(page, "not the password");
  await expect(page.getByText("Couldn't sign you in.")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\/$/);
  await expectAccessible(page);
});

test("signing in lands on the empty dashboard", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("No monitors yet.")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Dashboard" });
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);

  await nav.getByRole("link", { name: "Components" }).click();
  await expect(page.getByRole("heading", { name: "Components" })).toBeVisible();
  await expectAccessible(page);
});
