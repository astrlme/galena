import { expect, test } from "vitest";
import { heartbeatCheck } from "./heartbeat.ts";

// Hourly, with 5 minutes' grace; the current URL was made at 08:00.
const settings = {
  periodMinutes: 60,
  graceMinutes: 5,
  tokenIssuedAt: "2026-11-07T08:00:00.000Z",
};
const issued = Date.parse(settings.tokenIssuedAt);
const at = (iso: string) => new Date(iso);
const ping = (iso: string, issuedAt = issued) => ({ at: Date.parse(iso), issuedAt });

test("waits quietly until the first check-in", () => {
  expect(heartbeatCheck(settings, undefined, at("2026-11-08T12:00:00.000Z"))).toBeUndefined();
});

test("is up until the period and its grace have passed since the last check-in", () => {
  const last = ping("2026-11-07T10:00:00.000Z");
  expect(heartbeatCheck(settings, last, at("2026-11-07T10:30:00.000Z"))).toEqual({
    status: "up",
    error: null,
  });
  expect(heartbeatCheck(settings, last, at("2026-11-07T11:05:00.000Z"))?.status).toBe("up");
});

test("is down once the grace has passed, saying when it last checked in and when it was due", () => {
  const last = ping("2026-11-07T10:00:00.000Z");
  expect(heartbeatCheck(settings, last, at("2026-11-07T11:05:01.000Z"))).toEqual({
    status: "down",
    error: {
      code: "heartbeat_missed",
      message: "No check-in since 2026-11-07 10:00 UTC; one was due by 11:00 UTC.",
    },
  });
});

test("a check-in through a replaced URL counts only up to when the new URL was made", () => {
  const newUrl = { ...settings, tokenIssuedAt: "2026-11-07T10:00:00.000Z" };
  // Sent through the old URL at 10:30, after the new one was made at 10:00.
  const late = ping("2026-11-07T10:30:00.000Z", issued);
  expect(heartbeatCheck(newUrl, late, at("2026-11-07T11:04:00.000Z"))?.status).toBe("up");
  expect(heartbeatCheck(newUrl, late, at("2026-11-07T11:06:00.000Z"))?.status).toBe("down");
  // One sent before the new URL was made counts as it is.
  const before = ping("2026-11-07T09:30:00.000Z", issued);
  expect(heartbeatCheck(newUrl, before, at("2026-11-07T10:36:00.000Z"))?.status).toBe("down");
});

test("a check-in through a URL newer than the settings know counts in full", () => {
  // `monitors.json` hasn't caught up with a new URL yet.
  const newer = ping("2026-11-07T12:00:00.000Z", Date.parse("2026-11-07T11:59:00.000Z"));
  expect(heartbeatCheck(settings, newer, at("2026-11-07T13:00:00.000Z"))?.status).toBe("up");
});
