import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { expect, test } from "@playwright/test";
import { draft, expectAccessible, signIn } from "./helpers.ts";

const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const MINUTE = 60_000;

// DynamoDB Local, as `pnpm dev:local` runs it (one shared database, the `telemetry` table).
const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: "http://localhost:8000",
    region: "eu-central-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);

test("a monitor's draft shows why it opened, with the failing regions in view", async ({
  page,
}, testInfo) => {
  const name = `Checkout ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const created = await page.request.post("/v1/monitors", {
    data: { name, http: { url: "https://checkout.example.com/health" } },
  });
  expect(created.status()).toBe(201);
  const { id: monitorId } = (await created.json()) as { id: string };

  // 40 minutes of checks to now: Ireland and Paris time out for the last 4, Stockholm answers.
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  const items = Array.from({ length: 40 }, (_, ago) => now - ago * MINUTE).flatMap((at) =>
    REGIONS.map((region) => {
      const down = region !== "eu-north-1" && at > now - 4 * MINUTE;
      return {
        pk: `MON#${monitorId}`,
        sk: `R#${new Date(at).toISOString()}#${region}`,
        status: down ? "down" : "up",
        latencyMs: down ? null : 140,
        error: down ? { code: "timeout", message: "No complete response within 10000 ms." } : null,
        ttl: 0,
      };
    }),
  );
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    await doc.send(new BatchWriteCommand({ RequestItems: { telemetry: batch } }));
  }
  const id = draft(`${name} is down`, monitorId);

  await page.goto(`/dashboard/incidents/view/?id=${id}`);
  const why = page.getByRole("region", { name: "Why it opened" });
  await expect(why).toContainText(
    `${name} failed in 2 of 3 regions from ${new Date(now - 3 * MINUTE).toISOString().slice(11, 16)} UTC: No complete response within 10000 ms. Before that it answered in 140 ms.`,
  );
  const regions = page.getByRole("list", { name: "Checks by region" });
  const failing = regions.getByRole("listitem").filter({ hasText: "Failing since" });
  await expect(failing).toHaveCount(2);
  await expect(regions.getByRole("listitem").filter({ hasText: "Stockholm" })).toContainText(
    "Answering in 140 ms",
  );
  if (!testInfo.project.name.startsWith("phone")) {
    // At 1280 by 800, the regions that fail are there without scrolling.
    for (const row of await failing.all()) await expect(row).toBeInViewport({ ratio: 1 });
  }
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText(
    "Draft written: Investigating",
  );
  await expectAccessible(page);

  // Leave the shared local database without an open incident or a failing monitor from this run.
  await page.request.post(`/v1/incidents/${id}/decision`, { data: { decision: "dismiss" } });
  await page.request.delete(`/v1/monitors/${monitorId}`);
});
