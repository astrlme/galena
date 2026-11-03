import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, rowAction, signIn } from "./helpers.ts";

/** A local endpoint the local hot path checks on 127.0.0.1; closed, it refuses connections. */
async function endpoint() {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, close };
}

async function addMonitor(page: Page, name: string, url: string) {
  await page
    .getByRole("region", { name: "All monitors" })
    .getByRole("button", { name: "Add monitor" })
    .click();
  const form = page.getByRole("form", { name: "Add a monitor" });
  await form.getByLabel("Monitor name").fill(name);
  await form.getByLabel("URL").fill(url);
  await form.getByRole("button", { name: "Add monitor" }).click();
  await expect(form).toBeHidden();
}

async function deleteMonitor(page: Page, name: string) {
  const row = page.getByRole("row").filter({ hasText: name });
  await rowAction(row, name, "Delete");
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the monitor name").fill(name);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(row).toHaveCount(0);
}

test("a monitor turns down when the endpoint it checks stops answering", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const checked = await endpoint();
  const name = `Local ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");
  await addMonitor(page, name, checked.url);

  const row = page.getByRole("region", { name: "All monitors" }).getByRole("row").filter({
    hasText: name,
  });
  // Three regions agree it answers; the page polls every 30 s.
  await expect(row).toContainText("Operational", { timeout: 90_000 });
  // Each region's glyph says its latest answer (in the tooltip and read out).
  await expect(row.getByTitle(/^eu-west-1: Operational, \d+ ms$/)).toBeAttached();
  await expectAccessible(page);

  await checked.close();
  await expect(row).toContainText("Major outage", { timeout: 90_000 });
  await expect(row.getByTitle(/: Major outage$/)).toHaveCount(3);
  await expectAccessible(page);

  await deleteMonitor(page, name);
});

test("the monitors page stops polling while nobody is there, says so, and starts again", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/monitors/");
  await expect(page.getByRole("region", { name: "All monitors" })).toBeVisible();
  const paused = page.getByText("Updates paused while you're away.");
  await expect(paused).toBeHidden();
  await page.clock.fastForward("16:00");
  await expect(paused).toBeVisible();
  await page.mouse.move(40, 40);
  await expect(paused).toBeHidden();
});
