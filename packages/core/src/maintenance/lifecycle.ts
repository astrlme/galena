import type { MaintenanceStatus } from "@galena/contracts";
import { err, ok, type Result } from "../result.ts";

// A maintenance window runs itself: the lifecycle task wakes at startsAt and endsAt and asks
// what is due. `verifying` exists for Statuspage compatibility; nothing automatic enters it.

export type MaintenanceWindow = { status: MaintenanceStatus; startsAt: Date; endsAt: Date };

export type MaintenanceStep =
  | { to: "in_progress"; event: "maintenance.started" }
  | { to: "completed"; event: "maintenance.completed" };

/** What waking at `now` changes: start the window, complete it, or nothing yet. */
export function maintenanceStep(window: MaintenanceWindow, now: Date): MaintenanceStep | null {
  const time = now.getTime();
  if (window.status === "scheduled" && time >= window.startsAt.getTime()) {
    return { to: "in_progress", event: "maintenance.started" };
  }
  const running = window.status === "in_progress" || window.status === "verifying";
  if (running && time >= window.endsAt.getTime()) {
    return { to: "completed", event: "maintenance.completed" };
  }
  return null;
}

/** Times, title, message and components can change until the window has completed. */
export function canEditMaintenance(status: MaintenanceStatus): boolean {
  return status !== "completed";
}

/** Cancelling completes a window that never started; one already running ends at endsAt. */
export function cancelMaintenance(
  status: MaintenanceStatus,
): Result<{ to: "completed"; event: "maintenance.cancelled" }, "illegal_transition"> {
  if (status !== "scheduled") {
    return err(
      "illegal_transition",
      "Only a window that hasn't started can be cancelled. Edit its end time instead.",
    );
  }
  return ok({ to: "completed", event: "maintenance.cancelled" });
}

/** Whether `at` falls inside a window: detection records transitions there as suppressed. */
export function inMaintenance(
  windows: ReadonlyArray<{ startsAt: string; endsAt: string }>,
  at: Date,
): boolean {
  const time = at.getTime();
  return windows.some((w) => Date.parse(w.startsAt) <= time && time < Date.parse(w.endsAt));
}
