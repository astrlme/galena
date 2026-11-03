import { expect, test } from "@playwright/test";
import { expectAccessible, openSection, rowAction, signIn } from "./helpers.ts";

test("add a monitor, edit it, pause it and delete it after confirming its name", async ({
  page,
}, testInfo) => {
  // The local database outlives runs, so every run uses names of its own.
  const run = `${testInfo.project.name} ${Date.now()}`;
  const [name, renamed] = [`API ${run}`, `Public API ${run}`];

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await openSection(page, "Monitors");
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
  await expect(page.getByText("Monitor added")).toBeVisible();
  const row = () => list.getByRole("row").filter({ hasText: name });
  await expect(row().getByTitle("https://api.example.com/health")).toHaveText(name);
  await expectAccessible(page);

  await rowAction(row(), name, "Edit");
  const edit = page.getByRole("form", { name: `Edit ${name}` });
  await expect(edit.getByLabel("Keyword (optional)")).toHaveValue("ok");
  await edit.getByLabel("Monitor name").fill(renamed);
  await edit.getByRole("radio", { name: /Internal only/ }).check();
  await edit.getByRole("button", { name: "Save monitor" }).click();
  await expect(edit).toBeHidden();
  const renamedRow = () => list.getByRole("row").filter({ hasText: renamed });
  await expect(renamedRow()).toBeVisible();
  // The list doesn't say the policy; the form keeps it.
  await rowAction(renamedRow(), renamed, "Edit");
  const again = page.getByRole("form", { name: `Edit ${renamed}` });
  await expect(again.getByRole("radio", { name: /Internal only/ })).toBeChecked();
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toBeHidden();

  await rowAction(renamedRow(), renamed, "Pause");
  await expect(page.getByText("Monitor paused")).toBeVisible();
  await expect(renamedRow()).toContainText("Paused");
  await rowAction(renamedRow(), renamed, "Resume");
  await expect(renamedRow()).not.toContainText("Paused");

  await rowAction(renamedRow(), renamed, "Delete");
  const dialog = page.getByRole("dialog", { name: `Delete ${renamed}?` });
  await dialog.getByLabel("Type the monitor name").fill(renamed);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(dialog).toBeHidden();
  await expect(renamedRow()).toHaveCount(0);
});
