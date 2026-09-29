import { type MaintenanceStatus, maintenanceStatuses } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  cancelMaintenance,
  canEditMaintenance,
  inMaintenance,
  type MaintenanceWindow,
  maintenanceStep,
} from "./lifecycle.ts";

const T0 = Date.parse("2026-09-29T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const window = (status: MaintenanceStatus = "scheduled"): MaintenanceWindow => ({
  status,
  startsAt: at(10),
  endsAt: at(40),
});

describe("maintenanceStep", () => {
  test("starts the window at startsAt and completes it at endsAt, nothing in between", () => {
    expect(maintenanceStep(window(), at(9))).toBeNull();
    expect(maintenanceStep(window(), at(10))).toEqual({
      to: "in_progress",
      event: "maintenance.started",
    });
    expect(maintenanceStep(window("in_progress"), at(39))).toBeNull();
    expect(maintenanceStep(window("in_progress"), at(40))).toEqual({
      to: "completed",
      event: "maintenance.completed",
    });
    expect(maintenanceStep(window("verifying"), at(41))).toEqual({
      to: "completed",
      event: "maintenance.completed",
    });
    expect(maintenanceStep(window("completed"), at(50))).toBeNull();
  });

  test("property: waking at any times only moves forward, and completes once past endsAt", () => {
    const order: MaintenanceStatus[] = ["scheduled", "in_progress", "completed"];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -60, max: 120 }), { maxLength: 20 }), (wakes) => {
        let current = window();
        for (const minute of wakes.sort((a, b) => a - b)) {
          const step = maintenanceStep(current, at(minute));
          if (!step) continue;
          expect(order.indexOf(step.to)).toBe(order.indexOf(current.status) + 1);
          current = { ...current, status: step.to };
        }
        // Two wakes after endsAt are always enough to finish, however late the first one was.
        for (const now of [at(41), at(42)]) {
          const step = maintenanceStep(current, now);
          if (step) current = { ...current, status: step.to };
        }
        expect(current.status).toBe("completed");
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("editing and cancelling", () => {
  test.each(maintenanceStatuses)("a %s window can be edited until it has completed", (status) => {
    expect(canEditMaintenance(status)).toBe(status !== "completed");
  });

  test("only a window that hasn't started can be cancelled", () => {
    expect(cancelMaintenance("scheduled")).toEqual({
      ok: true,
      value: { to: "completed", event: "maintenance.cancelled" },
    });
    for (const status of ["in_progress", "verifying", "completed"] as const) {
      expect(cancelMaintenance(status)).toMatchObject({
        ok: false,
        error: { code: "illegal_transition" },
      });
    }
  });
});

test("inMaintenance: from startsAt up to, not including, endsAt", () => {
  const windows = [{ startsAt: at(10).toISOString(), endsAt: at(40).toISOString() }];
  expect(inMaintenance(windows, at(9))).toBe(false);
  expect(inMaintenance(windows, at(10))).toBe(true);
  expect(inMaintenance(windows, at(39))).toBe(true);
  expect(inMaintenance(windows, at(40))).toBe(false);
  expect(inMaintenance([], at(20))).toBe(false);
});
