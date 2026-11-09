import { expect, test } from "@playwright/test";
import { dashboardNav, expectAccessible, signIn } from "./helpers.ts";

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

test("signing in lands on Home, which lists what exists", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  // The local database outlives runs, so ask the API what the overview should show.
  const { monitors } = (await (await page.request.get("/v1/monitors")).json()) as {
    monitors: unknown[];
  };
  // The rail beside the work lists every monitor.
  const rail = page.getByRole("region", { name: "Monitors" });
  if (monitors.length === 0) {
    await expect(rail).toContainText("No monitors yet.");
  } else {
    await expect(rail.getByRole("listitem")).toHaveCount(monitors.length);
  }
  // With or without monitors: a draft can come from an alert source.
  await expect(page.getByRole("heading", { name: "Open incidents", level: 2 })).toBeVisible();
  const nav = await dashboardNav(page);
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);

  // Status page opens on its first part, and stays current through all of them.
  await nav.getByRole("link", { name: "Status page" }).click();
  await expect(page.getByRole("heading", { name: "Components", level: 1 })).toBeVisible();
  // On a phone the menu closed on the way; open it again to see which section is current.
  const again = await dashboardNav(page);
  await expect(again.getByRole("link", { name: "Status page" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectAccessible(page);
});
