import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

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

test("signing in lands on the overview, which lists what exists", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  // The local database outlives runs, so ask the API what the overview should show.
  const { monitors } = (await (await page.request.get("/v1/monitors")).json()) as {
    monitors: unknown[];
  };
  if (monitors.length === 0) {
    await expect(page.getByText("No monitors yet.")).toBeVisible();
  } else {
    const count = `${monitors.length} ${monitors.length === 1 ? "monitor" : "monitors"}`;
    await expect(page.getByRole("heading", { name: count, level: 2 })).toBeVisible();
    await expect(page.getByRole("region", { name: count }).getByRole("listitem")).toHaveCount(
      monitors.length,
    );
  }
  const nav = page.getByRole("navigation", { name: "Dashboard" });
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page);

  await nav.getByRole("link", { name: "Components" }).click();
  await expect(page.getByRole("heading", { name: "Components" })).toBeVisible();
  await expectAccessible(page);
});
