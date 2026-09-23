import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("create a group, add components, reorder them and delete one after confirming its name", async ({
  page,
}, testInfo) => {
  // The local database outlives runs, so every run uses names of its own.
  const run = `${testInfo.project.name} ${Date.now()}`;
  const group = `Core ${run}`;
  const [first, second] = [`Checkout ${run}`, `Search ${run}`];

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Components" })
    .click();
  await expect(page.getByRole("heading", { name: "Components", level: 1 })).toBeVisible();

  await page.getByLabel("Group name").fill(group);
  await page.getByRole("button", { name: "Add group" }).click();
  const section = page.getByRole("region", { name: group });
  await expect(section).toBeVisible();

  // Rows repeat each name for screen readers inside their buttons, so match rows, not text.
  const rows = section.getByRole("listitem");
  for (const name of [first, second]) {
    await page.getByLabel("Component name").fill(name);
    await page.getByLabel("Group", { exact: true }).selectOption({ label: group });
    await page.getByRole("button", { name: "Add component" }).click();
    await expect(rows.filter({ hasText: name })).toHaveCount(1);
  }
  await expect(rows).toHaveText([new RegExp(first), new RegExp(second)]);
  await expect(rows.first()).toContainText("Operational");

  await section.getByRole("button", { name: `Move up ${second}` }).click();
  await expect(rows).toHaveText([new RegExp(second), new RegExp(first)]);
  await expectAccessible(page);

  await section.getByRole("button", { name: `Delete ${first}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${first}?` });
  const confirm = dialog.getByRole("button", { name: "Delete component" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type the component name").fill(`${first} (typo)`);
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type the component name").fill(first);
  await expectAccessible(page);
  await confirm.click();

  await expect(dialog).toBeHidden();
  await expect(rows).toHaveText([new RegExp(second)]);
  await expect(page.getByText(first, { exact: true })).toHaveCount(0);
});

test("the delete dialog closes on Escape without deleting", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/components/");
  const ungrouped = page.getByRole("region", { name: "Not in a group" });
  const firstRow = ungrouped.getByRole("listitem").first();
  const name = (await firstRow.locator("span.font-semibold").textContent()) ?? "";
  await ungrouped.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(ungrouped.getByRole("listitem").filter({ hasText: name })).toHaveCount(1);
});
