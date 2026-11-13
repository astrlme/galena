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

test("the dashboard draws edge to edge with the page's own colour behind the browser's bars", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover.*interactive-widget=resizes-content/,
  );
  const themes = page.locator('meta[name="theme-color"]');
  await expect(themes).toHaveCount(2);
  await expect(themes.first()).toHaveAttribute("media", "(prefers-color-scheme: light)");
  // Taps get each control's own pressed state, not the browser's flash; labels aren't selected.
  const styles = await page.evaluate(() => {
    const button = document.querySelector("[data-dashboard] button");
    const heading = document.querySelector("h1");
    return {
      highlight: getComputedStyle(document.documentElement).getPropertyValue(
        "-webkit-tap-highlight-color",
      ),
      touch: button && getComputedStyle(button).touchAction,
      buttonSelect: button && getComputedStyle(button).userSelect,
      textSelect: heading && getComputedStyle(heading).userSelect,
    };
  });
  expect(styles).toEqual({
    highlight: "rgba(0, 0, 0, 0)",
    touch: "manipulation",
    buttonSelect: "none",
    textSelect: "auto",
  });

  // The landing page and docs keep their own settings.
  await page.goto("/");
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(0);
});
