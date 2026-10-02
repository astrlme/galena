import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

/** A datetime-local value in UTC, `hours` from now, as the form reads it. */
const utc = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 16);

test("schedule a window, change it, then cancel it after confirming its name", async ({
  page,
}, testInfo) => {
  const title = `Database upgrade ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Maintenance" })
    .click();
  await expect(page.getByRole("heading", { name: "Maintenance", level: 1 })).toBeVisible();

  const upcoming = page.getByRole("region", { name: "Upcoming and running" });
  await upcoming.getByRole("button", { name: "Schedule window" }).click();
  const form = page.getByRole("form", { name: "Schedule a window" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Starts (UTC)").fill(utc(2));
  await form.getByLabel("Ends (UTC)").fill(utc(1));
  await form.getByRole("checkbox", { name: "API" }).check();
  await form.getByLabel("Message").fill("Writes pause for up to 5 minutes.");
  await form.getByRole("button", { name: "Schedule window" }).click();
  await expect(form).toContainText("The window must end after it starts.");

  await form.getByLabel("Ends (UTC)").fill(utc(3));
  await form.getByRole("button", { name: "Schedule window" }).click();
  await expect(form).toBeHidden();
  const row = upcoming.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Scheduled.");
  await expect(row).toContainText("API.");
  await expectAccessible(page);

  await row.getByRole("button", { name: `Edit ${title}` }).click();
  const edit = page.getByRole("form", { name: `Edit ${title}` });
  await edit.getByLabel("Ends (UTC)").fill(utc(4));
  await edit.getByRole("button", { name: "Save window" }).click();
  await expect(edit).toBeHidden();

  await row.getByRole("button", { name: `Cancel ${title}` }).click();
  const dialog = page.getByRole("dialog", { name: `Cancel ${title}?` });
  await dialog.getByLabel("Type the window name").fill(title);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Cancel window" }).click();
  await expect(dialog).toBeHidden();

  const past = page
    .getByRole("region", { name: "Past" })
    .getByRole("listitem")
    .filter({ hasText: title });
  await expect(past).toContainText("Cancelled.");
  await expect(upcoming.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  await expectAccessible(page);
});
