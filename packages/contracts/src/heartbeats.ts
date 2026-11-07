import { z } from "zod";

// Heartbeat monitors: a scheduled job checks in through a ping URL, and the sweeper judges each
// minute from the newest check-in.

const MONTH_MINUTES = 30 * 24 * 60;

/** When a heartbeat is late: no check-in for `periodMinutes`, plus `graceMinutes` to spare. */
export const heartbeatSchedule = z.object({
  periodMinutes: z
    .int()
    .min(1, "A check-in can be expected once a minute at most.")
    .max(MONTH_MINUTES, "Expect a check-in at least once every 30 days."),
  graceMinutes: z
    .int()
    .min(1, "Allow at least 1 minute of grace.")
    .max(MONTH_MINUTES, "Allow at most 30 days of grace."),
});
export type HeartbeatSchedule = z.infer<typeof heartbeatSchedule>;

/** As stored: the schedule, and when the current ping URL was made (its token carries it). */
export const heartbeatSettings = heartbeatSchedule.extend({ tokenIssuedAt: z.iso.datetime() });
export type HeartbeatSettings = z.infer<typeof heartbeatSettings>;

/** A heartbeat monitor's new ping URL, shown once. */
export const pingUrl = z.object({ url: z.url() });

/** A heartbeat's recent check-ins, newest first, as its page lists them. */
export const checkIns = z.object({ checkIns: z.array(z.iso.datetime()) });

/** The sort key of a heartbeat monitor's newest check-in, `MON#<monitorId>` / `PING`. */
export const PING_KEY = "PING";

/** The newest check-in (epoch ms) and when the URL it came through was made. */
export const storedPing = z.object({
  at: z.number().nonnegative(),
  issuedAt: z.number().nonnegative(),
});
export type StoredPing = z.infer<typeof storedPing>;

/** The sort key prefix of each check-in kept for the page's list, `P#<ISO time>`. */
export const CHECK_IN_PREFIX = "P#";
