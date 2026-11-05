import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

/** A monitor of this run's own, added through the form. */
async function addMonitor(page: Page, name: string) {
  await page.goto("/dashboard/monitors/");
  await page.getByRole("button", { name: "Add monitor" }).click();
  const form = page.getByRole("form", { name: "Add a monitor" });
  await form.getByLabel("Monitor name").fill(name);
  await form.getByLabel("URL").fill("https://palette.example.com/health");
  await form.getByRole("button", { name: "Add monitor" }).click();
  await expect(form).toBeHidden();
}

test("Ctrl+K finds a monitor by part of its name and opens its page", async ({
  page,
}, testInfo) => {
  const stamp = `${testInfo.project.name.replace(/\W/g, "")}${Date.now()}`;
  const name = `Palette check ${stamp}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await addMonitor(page, name);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search the dashboard" });
  await palette.getByRole("combobox").fill(`check ${stamp}`);
  await expect(palette.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Enter");

  // A monitor opens its own page.
  await expect(page).toHaveURL(/\/dashboard\/monitors\/view\/\?id=/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Delete monitor" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the monitor name").fill(name);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});

test("the Search button opens the same palette, and an action starts its form", async ({
  page,
}) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("button", { name: /^Search/ })
    .filter({ visible: true })
    .click();
  const palette = page.getByRole("dialog", { name: "Search the dashboard" });
  await palette.getByRole("combobox").fill("schedule");
  await palette.getByRole("option", { name: "Schedule window" }).click();
  await expect(page).toHaveURL(/\/dashboard\/status-page\/maintenance\/$/);
  await expect(page.getByRole("form", { name: "Schedule a window" })).toBeVisible();
});
