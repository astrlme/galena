import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("add an Alertmanager integration with a route, see its URL once, and edit it", async ({
  page,
}, testInfo) => {
  const name = `Prometheus ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Integrations" })
    .click();
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();

  await page
    .getByRole("region", { name: "Alert sources" })
    .getByRole("button", { name: "Add integration" })
    .click();
  const form = page.getByRole("form", { name: "Add an integration" });
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Add route" }).click();
  // Labels are typed as name=value pairs, and a route marks at least one component.
  await form.getByLabel("Route 1 labels").fill("service api");
  await form.getByRole("button", { name: "Add integration" }).click();
  await expect(form).toContainText("Write labels as name=value, separated by commas");
  await expect(form).toContainText("Pick at least one component.");

  await form.getByLabel("Route 1 labels").fill("service=api");
  const marks = form.getByRole("group", { name: "Components it marks" });
  const first = marks.getByRole("checkbox").first();
  const component = (await marks.locator("label").first().innerText()).trim();
  await first.check();
  await form.getByRole("button", { name: "Add integration" }).click();

  const shown = page.getByRole("status").filter({ hasText: `Hook URL for ${name}` });
  await expect(shown).toContainText("/hooks/alertmanager/hook.");
  const url = (await shown.locator(".font-mono").innerText()).trim();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(shown).toBeHidden();

  const row = page
    .getByRole("region", { name: "Alert sources" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(row).toContainText(`Alertmanager. Ask a person first. service=api: ${component}`);
  await expect(row).toContainText("No alerts yet.");
  // The URL holds the token: the page never shows it again.
  await expect(page.getByText(url)).toHaveCount(0);

  await row.getByRole("button", { name: `Edit ${name}` }).click();
  const edit = page.getByRole("form", { name: `Edit ${name}` });
  await expect(edit.getByLabel("Route 1 labels")).toHaveValue("service=api");
  await edit.getByLabel("Publish automatically").check();
  await edit.getByRole("button", { name: "Save integration" }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("Publish automatically.");
});
