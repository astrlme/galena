import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

test("publish an incident, post an update, resolve it", async ({ page }, testInfo) => {
  // The local database outlives runs, so every run uses a title of its own.
  const title = `API errors ${testInfo.project.name} ${Date.now()}`;

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: "Incidents" })
    .click();
  await expect(page.getByRole("heading", { name: "Incidents", level: 1 })).toBeVisible();

  await page
    .getByRole("region", { name: "Open incidents" })
    .getByRole("button", { name: "Publish incident" })
    .click();
  const form = page.getByRole("form", { name: "Publish an incident" });
  await form.getByLabel("Title").fill(title);
  await form.getByRole("radio", { name: /Major impact/ }).check();
  await form.getByRole("checkbox", { name: "API" }).check();
  await expect(form.getByLabel("Status of API")).toHaveValue("partial_outage");
  // The message starts from the template, with the component filled in.
  const message = form.getByLabel("Message");
  await expect(message).toHaveValue(
    "We're seeing {symptom} on API from {regions}. We're investigating and will update by {nextUpdate}.",
  );
  await form.getByRole("button", { name: "Publish incident" }).click();
  await expect(form).toContainText("Replace {symptom} with the details before posting.");
  await expectAccessible(page);

  await message.fill(
    "We're seeing errors on API from 3 regions. We're investigating and will update by 14:30 UTC.",
  );
  await form.getByRole("button", { name: "Publish incident" }).click();

  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.getByText("Investigating. Major impact.")).toBeVisible();
  const affected = page.getByRole("list", { name: "Affected components" });
  await expect(affected).toContainText("API");
  await expect(affected).toContainText("Partial outage");

  const update = page.getByRole("form", { name: "Post an update" });
  await update.getByLabel("Status", { exact: true }).selectOption("identified");
  await expect(update.getByLabel("Message")).toHaveValue(
    "We found the cause: {cause}. We're {action}. Next update by {nextUpdate}.",
  );
  await update
    .getByLabel("Message")
    .fill("We found the cause: a bad deploy. We're rolling it back. Next update by 14:45 UTC.");
  await update.getByRole("button", { name: "Post update" }).click();
  await expect(page.getByText("Identified. Major impact.")).toBeVisible();

  await update.getByLabel("Status", { exact: true }).selectOption("resolved");
  await expect(update.getByLabel("Message")).toHaveValue(
    "API has worked normally since {time}. {Summary}.",
  );
  await update
    .getByLabel("Message")
    .fill("API has worked normally since 14:40 UTC. The rollback fixed it.");
  await update.getByRole("button", { name: "Post update" }).click();
  await expect(page.getByText(/^Resolved\. Major impact\. Started .*, resolved /)).toBeVisible();
  const updates = page.getByRole("region", { name: "Updates" }).getByRole("listitem");
  await expect(updates).toHaveCount(3);
  await expect(updates.first()).toContainText("The rollback fixed it.");
  await expectAccessible(page);

  await page.getByRole("link", { name: "All incidents" }).click();
  await expect(
    page.getByRole("region", { name: "Resolved" }).getByRole("link", { name: title }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Open incidents" }).getByRole("link", { name: title }),
  ).toHaveCount(0);
  await expectAccessible(page);
});
