import { expect, test } from "@playwright/test";
import { expectAccessible } from "./helpers.ts";

test("the landing page pitches Galena and leads to the docs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "A status page that stays up when everything else is down",
  );
  await expect(page.getByRole("link", { name: "Deploy to AWS" })).toHaveAttribute(
    "href",
    "/docs/getting-started/self-hosting/",
  );
  await expect(page.getByRole("figure", { name: "An example page" })).toBeVisible();
  await expectAccessible(page);
});

test("a docs page shows its diagrams by name", async ({ page }) => {
  await page.goto("/docs/concepts/detection/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Detection");
  await expect(page.getByRole("img", { name: "Monitor states" })).toBeVisible();
  await expect(page.getByRole("img", { name: "An outage, minute by minute" })).toBeVisible();
  await expectAccessible(page);
});

test("the API reference is generated from the OpenAPI document", async ({ page }) => {
  await page.goto("/docs/reference/api/incidents/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Incidents");
  await expect(page.getByText("/v1/incidents/{id}/updates").first()).toBeVisible();
  await expectAccessible(page);
});

test("search finds a page by its content", async ({ page }) => {
  await page.goto("/docs/");
  await page.getByRole("button", { name: "Search" }).filter({ visible: true }).first().click();
  await page.getByRole("combobox", { name: "Search" }).fill("quorum");
  await expect(page.getByRole("dialog").getByText("Detection").first()).toBeVisible();
});
