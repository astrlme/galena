import { expect, type Locator, test } from "@playwright/test";
import { openSection, rowAction, signIn } from "./helpers.ts";

// Below 640 px every form and dialog is a bottom drawer.
test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1280) >= 640, "the bottom drawer is the phone's");
});

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
};

test("a form's drawer fits the screen, keeps Minimize off the handle and its foot in reach", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await openSection(page, "Monitors");
  const list = page.getByRole("region", { name: "All monitors" });
  await list.getByRole("button", { name: "Add monitor" }).click();
  const drawer = page.getByRole("dialog", { name: "Add a monitor" });
  const form = drawer.getByRole("form", { name: "Add a monitor" });
  await expect(form).toBeVisible();
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

  // Inside the visible viewport, short of its top edge.
  const height = page.viewportSize()?.height ?? 0;
  const frame = await box(drawer);
  expect(frame.y).toBeGreaterThanOrEqual(32);
  expect(Math.round(frame.y + frame.height)).toBeLessThanOrEqual(height);

  // Minimize has a row of its own under the handle, a full touch target, above the title.
  const handle = await box(drawer.locator("[data-vaul-handle]"));
  const minimize = await box(drawer.getByRole("button", { name: "Minimize" }));
  const title = await box(drawer.getByRole("heading", { name: "Add a monitor" }));
  expect(minimize.height).toBeGreaterThanOrEqual(44);
  expect(minimize.y).toBeGreaterThanOrEqual(handle.y + handle.height);
  expect(title.y).toBeGreaterThanOrEqual(minimize.y + minimize.height);

  // The form scrolls inside the drawer and stops there; the page behind isn't blurred.
  const styles = await form.evaluate((el) => {
    let body = el.parentElement;
    while (body && getComputedStyle(body).overflowY !== "auto") body = body.parentElement;
    const scrim = document.querySelector("[data-vaul-overlay]");
    return {
      overscroll: body && getComputedStyle(body).overscrollBehaviorY,
      foot: body && getComputedStyle(body).paddingBottom,
      blur: scrim && getComputedStyle(scrim).backdropFilter,
    };
  });
  // 24 px plus the home indicator's inset, which is 0 off a real phone.
  expect(styles).toEqual({ overscroll: "contain", foot: "24px", blur: "none" });
  const submit = form.getByRole("button", { name: "Add monitor" });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();

  // Minimize still keeps what was typed.
  await form.getByLabel("Monitor name").fill("Kept on a phone");
  await drawer.getByRole("button", { name: "Minimize" }).click();
  await expect(drawer).toBeHidden();
  const draft = page.getByRole("complementary", { name: "Drafts" }).getByRole("link");
  await expect(draft).toHaveText("Add a monitor");
  await draft.click();
  await expect(form.getByLabel("Monitor name")).toHaveValue("Kept on a phone");
  await form.getByRole("button", { name: "Discard" }).click();
});

test("the menu drawer floats inside the screen with its own scroll", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Menu" }).click();
  const menu = page.getByRole("dialog", { name: /menu/ });
  await expect(menu.getByRole("navigation", { name: "Dashboard" })).toBeVisible();
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const frame = await box(menu);
  expect(frame.x).toBeGreaterThanOrEqual(8);
  expect(frame.y).toBeGreaterThanOrEqual(8);
  const styles = await menu.evaluate((el) => ({
    overscroll: getComputedStyle(el).overscrollBehaviorY,
    blur: getComputedStyle(document.querySelector("[data-vaul-overlay]") ?? el).backdropFilter,
  }));
  expect(styles).toEqual({ overscroll: "contain", blur: "none" });
});

test("a toast stands above the drafts dock, and both take a full finger", async ({
  page,
}, testInfo) => {
  const name = `Toast ${testInfo.project.name} ${Date.now()}`;
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  const created = await page.request.post("/v1/monitors", {
    data: { name, http: { url: "https://toast.example.com/health" } },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  try {
    await page.goto("/dashboard/monitors/");
    const list = page.getByRole("region", { name: "All monitors" });
    await list.getByRole("button", { name: "Add monitor" }).click();
    const drawer = page.getByRole("dialog", { name: "Add a monitor" });
    await drawer.getByLabel("Monitor name").fill("Waiting on a phone");
    await drawer.getByRole("button", { name: "Minimize" }).click();
    const chip = page.getByRole("complementary", { name: "Drafts" }).getByRole("link");
    await expect(chip).toBeVisible();

    await list.getByRole("searchbox").fill(name);
    await rowAction(list, name, "Pause");
    const toast = page.locator("[data-toasts] > *").filter({ hasText: "Monitor paused" });
    await expect(toast).toBeVisible();
    // Read together: the toast leaves after 6 s.
    const [above, dismiss, dock] = await Promise.all([
      box(toast),
      // Base UI hides Dismiss from assistive tech until focus moves into the toasts.
      box(toast.locator("button")),
      box(chip),
    ]);
    expect(above.y + above.height).toBeLessThanOrEqual(dock.y);
    expect(dismiss.height).toBeGreaterThanOrEqual(44);
    expect(dock.height).toBeGreaterThanOrEqual(44);
    expect((await box(list.getByRole("button", { name: "Add monitor" }))).height).toBe(44);

    await chip.click();
    await drawer.getByRole("button", { name: "Discard" }).click();
  } finally {
    await page.request.delete(`/v1/monitors/${id}`);
  }
});
