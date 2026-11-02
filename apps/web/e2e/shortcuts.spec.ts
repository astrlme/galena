import { expect, test } from "@playwright/test";
import { draft, expectAccessible, signIn } from "./helpers.ts";

test("G then a letter goes to a section, and ? lists every shortcut", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("m");
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.getByRole("heading", { name: "Components", level: 1 })).toBeVisible();

  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toContainText("Approving a draft has no shortcut");
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("C adds in this list; J moves to a row and E edits it", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible();

  await page.keyboard.press("c");
  const add = page.getByRole("form", { name: "Add a monitor" });
  await expect(add).toBeVisible();
  await add.getByLabel("Monitor name").fill(`Shortcut ${Date.now()}`);
  await add.getByLabel("URL").fill("https://shortcut.example.com/health");
  await add.getByRole("button", { name: "Add monitor" }).click();
  await expect(add).toBeHidden();

  await page.keyboard.press("j");
  await expect(page.locator(":focus")).toHaveAccessibleName(/^Actions for /);
  await page.keyboard.press("e");
  await expect(page.getByRole("form", { name: /^Edit / })).toBeVisible();
});

test("shortcuts stay out of the way while someone types", async ({ page }, testInfo) => {
  // The update form sits on the page itself, outside any dialog.
  const id = draft(`Typing check ${testInfo.project.name} ${Date.now()}`);
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto(`/dashboard/incidents/view/?id=${id}`);
  const message = page.getByRole("form", { name: "Post an update" }).getByLabel("Message");
  await message.fill("");
  await message.pressSequentially("gm c?");
  await expect(message).toHaveValue("gm c?");
  await expect(page).toHaveURL(/\/dashboard\/incidents\/view\//);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();

  // Leave the shared local database without an open incident from this run.
  await page.request.post(`/v1/incidents/${id}/decision`, { data: { decision: "dismiss" } });
});
