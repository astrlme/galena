import { expect, test } from "@playwright/test";
import { draft, journey, rowAction, signIn } from "./helpers.ts";

// How many clicks the work people come for takes. Each journey starts where a person would and
// counts only the clicks of the task itself; the dashboard must not get slower to use.

test("a monitor's draft is approved from the overview in 2 clicks", async ({ page }, testInfo) => {
  const title = `Payments is down ${testInfo.project.name} ${Date.now()}`;
  const id = draft(title);
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);

  const j = journey();
  await j.click(page.getByRole("link", { name: title }));
  await j.click(page.getByRole("button", { name: "Approve and publish" }));
  await expect(page.getByText("Incident published")).toBeVisible();
  expect(j.clicks).toBeLessThanOrEqual(2);

  // Leave the shared local database without an open incident from this run.
  await page.request.post(`/v1/incidents/${id}/updates`, {
    data: { status: "resolved", body: "Payments has worked normally since the test ended." },
  });
});

test("a monitor is paused from the monitors list in 2 clicks", async ({ page }, testInfo) => {
  const name = `Journey ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");
  await page.getByRole("button", { name: "Add monitor" }).click();
  const form = page.getByRole("form", { name: "Add a monitor" });
  await form.getByLabel("Monitor name").fill(name);
  await form.getByLabel("URL").fill("https://journey.example.com/health");
  await form.getByRole("button", { name: "Add monitor" }).click();
  await expect(form).toBeHidden();
  const row = page.getByRole("listitem").filter({ hasText: name });

  const j = journey();
  await j.click(row.getByRole("button", { name: `Actions for ${name}` }));
  await j.click(page.getByRole("menuitem", { name: "Pause", exact: true }));
  await expect(page.getByText("Monitor paused")).toBeVisible();
  await expect(row).toContainText("Paused.");
  expect(j.clicks).toBeLessThanOrEqual(2);

  await rowAction(row, name, "Delete");
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the monitor name").fill(name);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(row).toHaveCount(0);
});
