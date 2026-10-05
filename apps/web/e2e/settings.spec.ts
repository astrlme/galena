import { execSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, totp } from "./helpers.ts";

// Each run signs in as a member of its own (`member:local`), so the seeded owner every other
// spec uses never has two-factor turned on or its password changed.
const PASSWORD = "galena-local-member";
const NEW_PASSWORD = "a-new-password-for-this-run";

const member = (email: string) =>
  execSync("pnpm --filter @galena/api --silent member:local", {
    encoding: "utf8",
    env: { ...process.env, GLN_MEMBER_EMAIL: email },
  })
    .trim()
    .split("\n")
    .at(-1) ?? email;

async function signInAs(page: Page, email: string, password: string) {
  await page.goto("/sign-in/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("turn on two-factor, sign in with a backup code, change the password", async ({
  page,
  context,
}, testInfo) => {
  const email = member(`settings-${testInfo.project.name}-${Date.now()}@example.com`);
  await signInAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/settings/");
  await expect(page.getByText(/^Off\. Sign-in asks only for your password/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "This browser" })).toBeVisible();
  await expectAccessible(page);

  // Password, then the app's code, then the backup codes, shown once.
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Your password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    dialog.getByRole("img", { name: "QR code for your authenticator app" }),
  ).toBeVisible();
  await expectAccessible(page);
  const key = await dialog.getByTestId("totp-key").innerText();
  await dialog.getByLabel("Code from the app").fill(totp(key));
  await dialog.getByRole("button", { name: "Turn on two-factor" }).click();
  const listed = dialog.getByRole("list", { name: "Backup codes" }).getByRole("listitem");
  await expect(listed).toHaveCount(10);
  const codes = await listed.allInnerTexts();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/^On\. Sign-in asks for a code/)).toBeVisible();

  // A backup code stands in for the app at sign-in.
  await context.clearCookies();
  await signInAs(page, email, PASSWORD);
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(codes[0] ?? "");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);

  // A new password replaces the old one.
  await page.goto("/dashboard/settings/");
  await page.getByRole("button", { name: "Change password" }).click();
  await dialog.getByLabel("Current password").fill(PASSWORD);
  await dialog.getByLabel("New password").fill(NEW_PASSWORD);
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(
    page.getByText("Password changed. Your other sessions are signed out."),
  ).toBeVisible();
  await context.clearCookies();
  await signInAs(page, email, PASSWORD);
  await expect(page.getByText("Couldn't sign you in.")).toBeVisible();
  await signInAs(page, email, NEW_PASSWORD);

  // A backup code works once.
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(codes[0] ?? "");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page.getByText("That backup code didn't work.")).toBeVisible();
  await page.getByLabel("Backup code").fill(codes[1] ?? "");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);

  // And two-factor turns off again with the password.
  await page.goto("/dashboard/settings/");
  await page.getByRole("button", { name: "Turn off two-factor" }).click();
  await dialog.getByLabel("Your password").fill(NEW_PASSWORD);
  await dialog.getByRole("button", { name: "Turn off two-factor" }).click();
  await expect(page.getByText(/^Off\. Sign-in asks only for your password/)).toBeVisible();
});
