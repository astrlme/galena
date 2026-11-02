import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

// Bookmarks and links in emails sent before the dashboard was regrouped still land, query kept.
const MOVED = [
  ["/dashboard/components/", "/dashboard/status-page/components/", "Components"],
  ["/dashboard/maintenance/", "/dashboard/status-page/maintenance/", "Maintenance"],
  [
    "/dashboard/subscribers/?from=email",
    "/dashboard/status-page/subscribers/?from=email",
    "Subscribers",
  ],
  ["/dashboard/internal/", "/dashboard/status-page/internal/", "Internal page"],
  ["/dashboard/status-page/", "/dashboard/status-page/components/", "Components"],
] as const;

test("every old dashboard address lands in its new place", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  for (const [from, to, heading] of MOVED) {
    await page.goto(from);
    await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === to);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  }
});
