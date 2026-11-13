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

test("while the workspace loads, the dashboard's frame holds still blocks, then explains the wait", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  // As after the database's idle pause: /v1/me answers only when the test says so.
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/v1/me", async (route) => {
    await held;
    await route.continue();
  });
  await page.clock.install();
  await page.goto("/dashboard/monitors/");

  // The phone's bar, or the sidebar from 768 px, around the blocks.
  const frame = page.locator("[data-dashboard]");
  await expect(frame.getByText("galena", { exact: true }).filter({ visible: true })).toHaveCount(1);
  const status = frame.getByRole("status");
  await expect(status).toHaveText("Loading your workspace");
  await expect(status.locator(".bg-mist").first()).toBeVisible();
  await expectAccessible(page);

  await page.clock.fastForward(10_000);
  await expect(status).toHaveText(
    "Waking the database. This takes about 15 seconds after a quiet period.",
  );

  answer();
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible();

  // An API that can't be reached says so in the same frame.
  await page.unroute("**/v1/me");
  await page.route("**/v1/me", (route) => route.abort());
  await page.reload();
  await expect(frame.getByRole("main")).toHaveText(
    "Couldn't load your workspace. Check your connection, then reload the page.",
  );
});
