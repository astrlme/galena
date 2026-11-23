import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { histogramOf, quantileOf, rollUp } from "@galena/core";
import { expect, test } from "@playwright/test";
import { choose, expectAccessible, isPhone, rowAction, signIn } from "./helpers.ts";

const DAY = 86_400_000;

// DynamoDB Local, as `pnpm dev:local` runs it (one shared database, the `telemetry` table).
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: "http://localhost:8000",
    region: "eu-central-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);

test("last month's report shows a monitor's uptime and SLA budget, and downloads as CSV", async ({
  page,
}, testInfo) => {
  const name = `Reported ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const created = await page.request.post("/v1/monitors", {
    data: { name, http: { url: "https://reported.example.com/health" } },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  // Last month as the rollup leaves it: every day checked whole, 30 minutes down on its first,
  // and a day's answers in Ireland.
  const now = new Date();
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const month = new Date(first).toISOString().slice(0, 7);
  const label = new Date(first).toLocaleString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const days = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - first) / DAY;
  const answers = rollUp(
    [{ region: "eu-west-1", scheduledAt: "t", status: "up", latencyMs: 200, phases: null }],
    2,
  ).regions.get("eu-west-1");
  const items = Array.from({ length: days }, (_, n) => {
    const day = new Date(first + n * DAY).toISOString().slice(0, 10);
    return [
      { pk: `MON#${id}`, sk: `UD#${day}`, minutes: 1440, down: n === 0 ? 30 : 0, ttl: 0 },
      { pk: `MON#${id}`, sk: `D#${day}#eu-west-1`, ...answers, ttl: 0 },
    ];
  }).flat();
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await doc.send(new BatchWriteCommand({ RequestItems: { telemetry: batch } }));
  }

  // The target is set in the monitor's own form.
  await page.goto("/dashboard/monitors/");
  const list = page.getByRole("table", { name: "Monitors" });
  await rowAction(list.getByRole("row").filter({ hasText: name }), name, "Edit");
  const edit = page.getByRole("form", { name: `Edit ${name}` });
  // Typed with its % sign, as people do.
  await edit.getByLabel("SLA target (optional)").fill("99.9%");
  await edit.getByRole("button", { name: "Save monitor" }).click();
  await expect(edit).toBeHidden();

  await page.getByRole("link", { name: "Uptime reports" }).click();
  await expect(page.getByRole("heading", { name: "Uptime reports", level: 1 })).toBeVisible();
  await choose(page.locator("main"), "Month", label);
  const row = page.getByRole("table", { name: `Monitors, ${label}` }).getByRole("row", {
    name: new RegExp(name),
  });
  // 30 of a month's minutes down; 99.9% allows a thousandth of them, rounded down.
  const minutes = days * 1440;
  const allowed = Math.floor(minutes / 1000);
  // Rounded down to three decimals in the file, two on the page.
  const uptime = (Math.floor((1 - 30 / minutes) * 100_000) / 1000).toFixed(3);
  const p95 = Math.round(quantileOf(histogramOf([200]), 0.95) ?? 0);
  await expect(row).toContainText("99.93%");
  if (!isPhone(page)) await expect(row).toContainText(`${allowed - 30}m left of ${allowed}m`);
  await expectAccessible(page);

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`uptime-${month}.csv`);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv.split("\r\n")).toContain(
    `monitor,${name},${month},${minutes},30,${uptime},0,${p95},99.9,${allowed},${allowed - 30}`,
  );

  expect((await page.request.delete(`/v1/monitors/${id}`)).status()).toBe(204);
});
