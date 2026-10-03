import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("a minimized form waits in the dock, survives a reload and reopens where it was", async ({
  page,
}, testInfo) => {
  const name = `Draft ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");

  await page.getByRole("button", { name: "Add monitor" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a monitor" });
  await expect(sheet.getByLabel("Monitor name")).toBeFocused();
  await sheet.getByLabel("Monitor name").fill(name);
  await expect(sheet.getByRole("button", { name: "Discard" })).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Minimize" }).click();
  await expect(sheet).toBeHidden();

  const dock = page.getByRole("complementary", { name: "Drafts" });
  await expect(dock.getByRole("link", { name: "Add a monitor" })).toBeVisible();
  await expectAccessible(page);

  // Kept in the browser, so a reload or another section keeps it too.
  await page.goto("/dashboard/incidents/");
  await dock.getByRole("link", { name: "Add a monitor" }).click();
  await expect(page).toHaveURL(/\/dashboard\/monitors\/$/);
  await expect(sheet.getByLabel("Monitor name")).toHaveValue(name);

  await sheet.getByRole("button", { name: "Discard" }).click();
  await expect(sheet).toBeHidden();
  await expect(dock).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Add monitor" }).click();
  await expect(sheet.getByLabel("Monitor name")).toHaveValue("");
});

test("sending a restored draft clears it", async ({ page }, testInfo) => {
  const name = `Draft group ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/components/");
  await page.getByRole("button", { name: "Add group" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a group" });
  await sheet.getByLabel("Group name").fill(name);
  await page.keyboard.press("Escape"); // closing any way keeps what was typed
  await expect(sheet).toBeHidden();

  await page.reload();
  const dock = page.getByRole("complementary", { name: "Drafts" });
  await dock.getByRole("link", { name: "Add a group" }).click();
  await expect(sheet.getByLabel("Group name")).toHaveValue(name);
  await sheet.getByRole("button", { name: "Add group" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  await expect(dock).toBeHidden();

  // Leave the shared local database as it was.
  const { groups } = (await (await page.request.get("/v1/components")).json()) as {
    groups: { id: string; name: string }[];
  };
  const created = groups.find((g) => g.name === name);
  if (created) await page.request.delete(`/v1/component-groups/${created.id}`);
});

test("the sidebar collapses to a rail of named icons and stays that way", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const nav = page.getByRole("navigation", { name: "Dashboard" });
  await nav.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(nav.getByText("owner@example.com")).toBeHidden();
  await expectAccessible(page);

  await page.reload();
  await expect(nav.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await nav.getByRole("link", { name: "Monitors" }).click();
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible();
  await nav.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(nav.getByText("owner@example.com")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the menu opens the sections in a drawer that closes on the way", async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/dashboard\/$/);
    await page.getByRole("button", { name: "Menu" }).click();
    const menu = page.getByRole("dialog", { name: /menu/ });
    await expect(menu.getByText("owner@example.com")).toBeVisible();
    await expectAccessible(page);

    await menu
      .getByRole("navigation", { name: "Dashboard" })
      .getByRole("link", { name: "Incidents" })
      .click();
    await expect(page.getByRole("heading", { name: "Incidents", level: 1 })).toBeVisible();
    await expect(menu).toBeHidden();
  });

  test("forms open in a bottom drawer and minimize the same way", async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/dashboard\/$/);
    await page.goto("/dashboard/maintenance/");
    await page.getByRole("button", { name: "Schedule window" }).click();
    const sheet = page.getByRole("dialog", { name: "Schedule a window" });
    await sheet.getByLabel("Title").fill("Phone draft");
    await sheet.getByRole("button", { name: "Minimize" }).click();
    const dock = page.getByRole("complementary", { name: "Drafts" });
    await dock.getByRole("link", { name: "Schedule a window" }).click();
    await expect(sheet.getByLabel("Title")).toHaveValue("Phone draft");
    await sheet.getByRole("button", { name: "Discard" }).click();
    await expect(dock).toBeHidden();
  });
});
