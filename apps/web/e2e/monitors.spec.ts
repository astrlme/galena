import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("add a monitor, edit it, pause it and delete it after confirming its name", async ({
  page,
}, testInfo) => {
  // The local database outlives runs, so every run uses names of its own.
  const run = `${testInfo.project.name} ${Date.now()}`;
  const [name, renamed] = [`API ${run}`, `Public API ${run}`];

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Monitors" })
    .click();
  await expect(page.getByRole("heading", { name: "Monitors", level: 1 })).toBeVisible();

  const list = page.getByRole("region", { name: "All monitors" });
  await list.getByRole("button", { name: "Add monitor" }).click();
  const form = page.getByRole("form", { name: "Add a monitor" });
  // The default policy states its deadline in words.
  await expect(form.getByRole("radio", { name: /Ask a person first/ })).toBeChecked();
  await expect(form).toContainText(
    "Drafts wait 10 minutes for a person, then publish if the monitor is still down.",
  );

  await form.getByLabel("Monitor name").fill(name);
  await form.getByLabel("URL").fill("http://169.254.169.254/latest/meta-data/");
  await form.getByRole("button", { name: "Add monitor" }).click();
  await expect(page.getByText(/Private and reserved addresses are never checked/)).toBeVisible();

  await form.getByLabel("URL").fill("https://api.example.com/health");
  await form.getByLabel("Keyword (optional)").fill("ok");
  await form.getByRole("button", { name: "Add monitor" }).click();
  await expect(form).toBeHidden();
  // Rows repeat each name for screen readers inside their buttons, so match rows, not text.
  const row = () => list.getByRole("listitem").filter({ hasText: "api.example.com" }).last();
  await expect(row()).toContainText(name);
  await expect(row()).toContainText("Ask a person first.");
  await expectAccessible(page);

  await row()
    .getByRole("button", { name: `Edit ${name}` })
    .click();
  const edit = page.getByRole("form", { name: `Edit ${name}` });
  await expect(edit.getByLabel("Keyword (optional)")).toHaveValue("ok");
  await edit.getByLabel("Monitor name").fill(renamed);
  await edit.getByRole("radio", { name: /Internal only/ }).check();
  await edit.getByRole("button", { name: "Save monitor" }).click();
  await expect(edit).toBeHidden();
  await expect(row()).toContainText(renamed);
  await expect(row()).toContainText("Internal only.");

  await row()
    .getByRole("button", { name: `Pause ${renamed}` })
    .click();
  await expect(row()).toContainText("Paused.");
  await row()
    .getByRole("button", { name: `Resume ${renamed}` })
    .click();
  await expect(row()).not.toContainText("Paused.");

  await row()
    .getByRole("button", { name: `Delete ${renamed}` })
    .click();
  const dialog = page.getByRole("dialog", { name: `Delete ${renamed}?` });
  await dialog.getByLabel("Type the monitor name").fill(renamed);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(dialog).toBeHidden();
  await expect(list.getByRole("listitem").filter({ hasText: renamed })).toHaveCount(0);
});
