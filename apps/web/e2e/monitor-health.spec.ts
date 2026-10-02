import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("a monitor turns down when the endpoint it checks stops answering", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  // The endpoint lives in this test; the local hot path reaches it on 127.0.0.1.
  const endpoint = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/`;
  const name = `Local ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");
  await page
    .getByRole("region", { name: "All monitors" })
    .getByRole("button", { name: "Add monitor" })
    .click();
  const form = page.getByRole("form", { name: "Add a monitor" });
  await form.getByLabel("Monitor name").fill(name);
  await form.getByLabel("URL").fill(url);
  await form.getByRole("button", { name: "Add monitor" }).click();

  const row = page
    .getByRole("region", { name: "All monitors" })
    .getByRole("listitem")
    .filter({ hasText: name });
  // Three regions agree it answers; the page polls every 30 s.
  await expect(row).toContainText("Operational", { timeout: 90_000 });
  await expect(row.getByRole("definition").first()).toHaveText(/^\d+ ms$/);
  await expectAccessible(page);

  endpoint.closeAllConnections();
  await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  await expect(row).toContainText("Major outage", { timeout: 90_000 });
  await expect(row.getByRole("definition")).toHaveText(["Down", "Down", "Down"]);
  await expect(row.getByRole("img", { name: /down everywhere/ })).toBeVisible();
  await expectAccessible(page);

  await row.getByRole("button", { name: `Delete ${name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the monitor name").fill(name);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(row).toHaveCount(0);
});
