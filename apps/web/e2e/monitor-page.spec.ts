import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { expiryKey, expiryPartition, workspaceId } from "@galena/contracts";
import { histogramOf, quantileOf, rollUp } from "@galena/core";
import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const HOUR = 3_600_000;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// DynamoDB Local, as `pnpm dev:local` runs it (one shared database, the `telemetry` table).
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: "http://localhost:8000",
    region: "eu-central-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);

/** One region's hour as `rollup.telemetry` writes it: 60 answers taking `ms` each. */
function hourItem(monitorId: string, start: number, region: string, ms: number) {
  const checks = Array.from({ length: 60 }, (_, n) => ({
    region,
    scheduledAt: new Date(start + n * 60_000).toISOString(),
    status: "up" as const,
    latencyMs: ms,
    phases: { dns: 5, connect: 10, tls: 20, ttfb: ms - 10, total: ms },
  }));
  const rollup = rollUp(checks, 2).regions.get(region);
  if (!rollup) throw new Error("no rollup");
  const hour = new Date(start).toISOString().slice(0, 13);
  return { pk: `MON#${monitorId}`, sk: `H#${hour}#${region}`, ...rollup, ttl: 0 };
}

/** What the page shows for an answer time: the histogram bucket's middle, rounded. */
const shown = (ms: number) => `${Math.round(quantileOf(histogramOf([ms]), 0.95) ?? 0)} ms`;

test("a monitor's page reads its 7-day p95, and each chart's table holds the chart's points", async ({
  page,
}, testInfo) => {
  const name = `Charted ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const created = await page.request.post("/v1/monitors", {
    data: { name, http: { url: "https://charted.example.com/health" } },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  // 170 hours to now, so the week the page reads is whole even if an hour turns meanwhile:
  // Paris answers in 500 ms, the others in 300 ms, except one hour in Ireland at 900 ms.
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  const slow = now - 30 * HOUR;
  const items = Array.from({ length: 170 }, (_, h) => now - h * HOUR).flatMap((start) =>
    REGIONS.map((region) =>
      hourItem(
        id,
        start,
        region,
        region === "eu-west-3" ? 500 : region === "eu-west-1" && start === slow ? 900 : 300,
      ),
    ),
  );
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await doc.send(new BatchWriteCommand({ RequestItems: { telemetry: batch } }));
  }

  await page.goto("/dashboard/monitors/");
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "7 days" }).click();
  await expect(page).toHaveURL(/range=7d/);

  // All regions together: a third of the answers took 500 ms, so the week's p95 is Paris's, though
  // no other region's is.
  const p95 = page
    .locator("dt", { hasText: "p95, last 7 days" })
    .locator("xpath=following-sibling::dd");
  await expect(p95).toHaveText(shown(500));
  // Every section loaded before axe looks.
  await expect(page.getByRole("group", { name: /uptime, the last/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Failed checks" })).toBeVisible();
  await expectAccessible(page);

  const ireland = page.getByRole("region", { name: "eu-west-1" });
  const slowAt = new Date(slow);
  const slowLabel = `${slowAt.getUTCDate()} ${MONTHS[slowAt.getUTCMonth()]}, ${String(slowAt.getUTCHours()).padStart(2, "0")}:00 UTC`;
  await expect(ireland).toContainText(`Highest hourly p95: ${shown(900)} at ${slowLabel}.`);
  await ireland.getByRole("button", { name: "Show as table" }).click();
  const table = ireland.getByRole("table");
  // A row per hour of the week, plus the header.
  await expect(table.getByRole("row")).toHaveCount(168 + 1);
  await expect(table.getByRole("row").filter({ hasText: slowLabel })).toContainText(shown(900));

  // The chart shows what the table says: the slow hour's place on Ireland's chart reads the
  // table's time and p95.
  const times = (await table.getByRole("row").allTextContents()).slice(1);
  const index = times.findIndex((t) => t.includes(slowLabel));
  expect(index).toBeGreaterThan(-1);
  const plot = await ireland.locator(".u-over").boundingBox();
  if (!plot) throw new Error("no plot");
  await page.mouse.move(plot.x + (plot.width * (index + 0.25)) / 168, plot.y + plot.height / 2);
  const readout = ireland.locator("[data-readout]");
  await expect(readout).toContainText(slowLabel);
  await expect(readout.locator("li", { hasText: "p95" })).toContainText(shown(900));
  await expectAccessible(page);

  await page.getByRole("button", { name: "Delete monitor" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
  await dialog.getByLabel("Type the monitor name").fill(name);
  await dialog.getByRole("button", { name: "Delete monitor" }).click();
  await expect(page).toHaveURL(/\/dashboard\/monitors\/$/);
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});

test("a certificate 10 days from expiry shows on Home and on its monitor's page", async ({
  page,
}, testInfo) => {
  const stamp = `${testInfo.project.name}-${Date.now()}`;
  const name = `Expiring ${stamp}`;
  const host = `expiring-${stamp}.example.com`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const created = await page.request.post("/v1/monitors", {
    data: { name, http: { url: `https://${host}/` } },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const me = (await (await page.request.get("/v1/me")).json()) as { workspaceId: string };
  // As the hourly scan stores it, a minute short of 10 days out.
  const expiresAt = new Date(Date.now() + 10 * 24 * HOUR - 60_000).toISOString();
  await doc.send(
    new PutCommand({
      TableName: "telemetry",
      Item: {
        pk: expiryPartition(workspaceId.parse(me.workspaceId)),
        sk: expiryKey({ kind: "certificate", name: host }),
        kind: "certificate",
        name: host,
        expiresAt,
        issuer: "Galena test CA",
        monitorIds: [id],
        checkedAt: new Date().toISOString(),
        sent: null,
        ttl: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  );

  await page.goto("/dashboard/");
  const soon = page.getByRole("region", { name: "Expiring soon" });
  const link = soon.getByRole("link", { name: `Certificate for ${host} expires in 10 days` });
  await expect(link).toBeVisible();
  await expect(soon).toContainText("Issued by Galena test CA.");
  await expectAccessible(page);

  await link.click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  const certificate = page
    .locator("dt", { hasText: "Certificate" })
    .locator("xpath=following-sibling::dd");
  await expect(certificate).toContainText("in 10 days. Issued by Galena test CA.");
  await expectAccessible(page);

  await page.request.delete(`/v1/monitors/${id}`);
});
