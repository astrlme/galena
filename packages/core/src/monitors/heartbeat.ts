import type { CheckResult, HeartbeatSettings, StoredPing } from "@galena/contracts";
import { utcTime } from "../incidents/autopilot.ts";

const MINUTE = 60_000;

/** `2026-11-07 10:00 UTC`: a heartbeat may be days apart, so the date stays in. */
const utcDateTime = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The check-in that counts (epoch ms): one through a replaced URL counts only up to when the new
 * URL was made, so a leaked old URL can't keep the monitor up.
 */
export function lastCheckIn(settings: Pick<HeartbeatSettings, "tokenIssuedAt">, ping: StoredPing) {
  const current = Date.parse(settings.tokenIssuedAt);
  return ping.issuedAt >= current ? ping.at : Math.min(ping.at, current);
}

/**
 * A heartbeat monitor's check for one minute, from its newest check-in: up until the period and
 * its grace have passed, then down. Undefined until the first check-in, so a job that hasn't
 * started yet raises nothing.
 */
export function heartbeatCheck(
  settings: HeartbeatSettings,
  ping: StoredPing | undefined,
  now: Date,
): Pick<CheckResult, "status" | "error"> | undefined {
  if (!ping) return undefined;
  const last = lastCheckIn(settings, ping);
  const due = last + settings.periodMinutes * MINUTE;
  if (now.getTime() <= due + settings.graceMinutes * MINUTE) return { status: "up", error: null };
  return {
    status: "down",
    error: {
      code: "heartbeat_missed",
      message: `No check-in since ${utcDateTime(last)}; one was due by ${utcTime(new Date(due))}.`,
    },
  };
}
