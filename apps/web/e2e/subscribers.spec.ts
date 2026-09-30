import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("add a webhook destination, see its secret once, then delete it after confirming its name", async ({
  page,
}, testInfo) => {
  const name = `Ops ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Subscribers" })
    .click();
  await expect(page.getByRole("heading", { name: "Subscribers", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Email" })).toBeVisible();

  const form = page.getByRole("form", { name: "Add a destination" });
  // A Slack destination must be Slack's own address.
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("URL").fill("https://example.com/hook");
  await form.getByRole("button", { name: "Add destination" }).click();
  await expect(form).toContainText(
    "Slack incoming webhook URLs start with https://hooks.slack.com/.",
  );

  await form.getByLabel("Kind").selectOption("webhook");
  await form.getByRole("button", { name: "Add destination" }).click();
  const secret = page.getByRole("status").filter({ hasText: `Signing secret for ${name}` });
  await expect(secret).toContainText("whsec_");
  await expectAccessible(page);

  const row = page
    .getByRole("region", { name: "Slack and webhooks" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(row).toContainText("Webhook. Active. All components.");
  // The URL is sealed on save: the page never shows it again.
  await expect(page.getByText("https://example.com/hook")).toHaveCount(0);

  await row.getByRole("button", { name: `Delete ${name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the destination name").fill(name);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Delete destination" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
});
