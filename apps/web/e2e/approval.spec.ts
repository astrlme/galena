import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

/** A monitor's draft on the local database (local development runs no autopilot). */
const draft = (title: string) =>
  execSync("pnpm --filter @galena/api --silent draft:local", {
    encoding: "utf8",
    env: { ...process.env, GLN_DRAFT_TITLE: title },
  })
    .trim()
    .split("\n")
    .at(-1);

test("approve one monitor draft and dismiss another before their deadline", async ({
  page,
}, testInfo) => {
  // The local database outlives runs, so every run uses titles of its own.
  const stamp = `${testInfo.project.name} ${Date.now()}`;
  const approved = draft(`Checkout is down ${stamp}`);
  const dismissed = draft(`Search is down ${stamp}`);

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto(`/dashboard/incidents/view/?id=${approved}`);
  const card = page.getByRole("region", { name: "Draft from a monitor" });
  await expect(card).toContainText("Publishes automatically at");
  await expect(card).toContainText("unless you approve or dismiss it sooner.");
  await expectAccessible(page);
  await card.getByRole("button", { name: "Approve and publish" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText(/^Draft|never published/)).toBeHidden();
  await expectAccessible(page);

  await page.goto(`/dashboard/incidents/view/?id=${dismissed}`);
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText("Dismissed, never published.")).toBeVisible();

  // Leave the shared local database without an open incident from this run.
  await page.request.post(`/v1/incidents/${approved}/updates`, {
    data: { status: "resolved", body: "Checkout has worked normally since the test ended." },
  });
});
