import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("post an incident to the internal page only", async ({ page }, testInfo) => {
  // The local database outlives runs, so every run uses a title of its own.
  const title = `Slow builds ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Incidents" })
    .click();
  await page
    .getByRole("region", { name: "Open incidents" })
    .getByRole("button", { name: "Publish incident" })
    .click();
  const form = page.getByRole("form", { name: "Publish an incident" });
  await form.getByLabel("Title").fill(title);
  await form
    .getByLabel("Message")
    .fill("Builds take twice as long as usual. We're looking into it.");
  await form.getByRole("checkbox", { name: /Internal page only/ }).check();
  // The button says what it does now: nothing is published.
  await expect(form.getByRole("button", { name: "Publish incident" })).toHaveCount(0);
  await expectAccessible(page);
  await form.getByRole("button", { name: "Post to the internal page" }).click();

  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.getByText("Internal page only, not on the status page.")).toBeVisible();
});

test("the internal page link says why it can't open without a signing key", async ({ page }) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Internal page" })
    .click();
  await expect(page.getByRole("heading", { name: "Internal page", level: 1 })).toBeVisible();
  // Locally there is no CloudFront and no key, so the API answers 503 with the way to fix it.
  await expect(page.getByText(/couldn't read the key that signs access/)).toBeVisible();
  await expectAccessible(page);
});
