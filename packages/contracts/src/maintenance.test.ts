import { expect, test } from "vitest";
import { maintenanceInput } from "./maintenance.ts";

const window = {
  title: "Database upgrade",
  body: "Writes pause for up to 5 minutes.",
  startsAt: "2026-09-29T22:00:00.000Z",
  endsAt: "2026-09-29T23:00:00.000Z",
  componentIds: [],
};

test("a window must end after it starts", () => {
  expect(maintenanceInput.safeParse(window).success).toBe(true);
  const backwards = maintenanceInput.safeParse({ ...window, endsAt: window.startsAt });
  expect(backwards.success).toBe(false);
  expect(backwards.error?.issues[0]).toMatchObject({
    path: ["endsAt"],
    message: "The window must end after it starts.",
  });
});
