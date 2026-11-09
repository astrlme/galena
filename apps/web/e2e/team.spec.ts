import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers.ts";

type Team = {
  members: { id: string; name: string; email: string; isYou: boolean; role: string }[];
};

test("the owner invites a viewer, who signs in read-only; the last owner can't be removed", async ({
  page,
  browser,
}, testInfo) => {
  // The local database outlives runs, so every run invites an address of its own.
  const email = `viewer-${testInfo.project.name}-${Date.now()}@example.com`;
  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.goto("/dashboard/settings/");
  const team = page.getByRole("region", { name: "Team" });
  await team.getByRole("button", { name: "Invite someone" }).click();
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Email").fill(email);
  // A new invite starts as a viewer.
  await expect(form.getByRole("combobox", { name: "Role" })).toContainText("Viewer");
  await form.getByRole("button", { name: "Invite" }).click();
  const made = page.getByRole("dialog", { name: `Invite for ${email}` });
  await expect(made).toContainText("It works once, for that address");
  const link = (await made.locator("p.font-mono").textContent())?.trim() ?? "";
  expect(link).toMatch(/\/invite\/\?token=invite\./);
  await expectAccessible(page);
  await made.getByRole("button", { name: "Done" }).click();
  await expect(team.getByRole("table", { name: "Open invites" })).toContainText(email);

  // The only owner (the seeded one): nothing on their row removes them, and the API refuses it.
  const before = (await (await page.request.get("/v1/team")).json()) as Team;
  expect(before.members.filter((m) => m.role === "owner")).toHaveLength(1);
  const me = before.members.find((m) => m.isYou);
  await expect(team.getByText("You're the only owner")).toBeVisible();
  await expect(team.getByRole("button", { name: `Actions for ${me?.name}` })).toHaveCount(0);
  const refused = await page.request.delete(`/v1/members/${me?.id}`);
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe("last_owner");

  // The invited person, in a browser of their own.
  const theirs = await browser.newContext({
    baseURL: testInfo.project.use.baseURL ?? "",
    viewport: page.viewportSize(),
    colorScheme: testInfo.project.use.colorScheme ?? "light",
  });
  const viewer = await theirs.newPage();
  await viewer.goto(link);
  await expect(viewer.getByRole("heading", { name: /^Join / })).toBeVisible();
  await expect(viewer.getByText(email)).toBeVisible();
  await expectAccessible(viewer);
  await viewer.getByLabel("Your name").fill("Read Only");
  await viewer.getByLabel("Password").fill("a long enough password");
  await viewer.getByRole("button", { name: "Accept invite" }).click();
  await expect(viewer).toHaveURL(/\/dashboard\/$/);
  await expect(viewer.getByText("You can view this workspace.")).toBeVisible();

  // Signed out, they sign in like anyone else, and stay read-only.
  await viewer.request.post("/auth/sign-out", { data: {} });
  await signIn(viewer, "a long enough password", email);
  await expect(viewer.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  const change = await viewer.request.post("/v1/monitors", {
    data: { name: "Not allowed", http: { url: "https://example.com/" } },
  });
  expect(change.status()).toBe(403);
  // The link worked once.
  await viewer.goto(link);
  await expect(viewer.getByText("It has been used. Sign in instead.")).toBeVisible();
  await theirs.close();

  // Leave the shared local database without this run's member.
  const after = (await (await page.request.get("/v1/team")).json()) as Team;
  const joined = after.members.find((m) => m.email === email);
  expect(joined?.role).toBe("viewer");
  if (joined) expect((await page.request.delete(`/v1/members/${joined.id}`)).status()).toBe(204);
});
