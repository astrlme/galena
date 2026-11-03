import {
  type MonitorId,
  type MonitorSummary,
  monitorSummary,
  storedCheck,
  storedMinutes,
  storedRegionRollup,
} from "@galena/contracts";
import type { MinuteCounts, RawCheck, RegionRollup } from "@galena/core";

// Rollups in the telemetry table, next to the raw checks under the monitor's `MON#<id>`:
//   H#<YYYY-MM-DDTHH>#<region>  one region's hour        (kept 30 days)
//   D#<YYYY-MM-DD>#<region>     one region's day         (kept 400 days)
//   UH#<YYYY-MM-DDTHH>          the monitor's minutes, an hour (kept 30 days)
//   UD#<YYYY-MM-DD>             the monitor's minutes, a day   (kept 400 days)
//   SUMMARY                     its last 24 hours and 30 days, for the monitors list (replaced hourly)
// Minutes live under their own prefixes, so a chart's range reads regions only: 90 days of three
// regions is 270 items.

const DAY_SECONDS = 24 * 60 * 60;
export const HOUR_TTL_SECONDS = 30 * DAY_SECONDS;
export const DAY_TTL_SECONDS = 400 * DAY_SECONDS;

export const monitorKey = (monitorId: MonitorId) => `MON#${monitorId}`;
export const regionHourKey = (hour: string, region: string) => `H#${hour}#${region}`;
export const regionDayKey = (day: string, region: string) => `D#${day}#${region}`;
export const minutesHourKey = (hour: string) => `UH#${hour}`;
export const minutesDayKey = (day: string) => `UD#${day}`;
export const SUMMARY_KEY = "SUMMARY";

/** The first and last sort key of a span of one kind, for a `BETWEEN` query. */
export const spanKeys = (prefix: "R" | "H" | "D" | "UH" | "UD", from: string, to: string) => ({
  from: `${prefix}#${from}`,
  // `~` sorts after every character a timestamp or region holds.
  to: `${prefix}#${to}~`,
});

type Item = Record<string, unknown>;

/** A region rollup read back; its hour or day and region are the parts of its sort key. */
export function regionRollupOf(item: Item): { at: string; region: string; rollup: RegionRollup } {
  const [, at = "", region = ""] = String(item.sk).split("#");
  return { at, region, rollup: storedRegionRollup.parse(item) };
}

export const minutesOf = (item: Item): MinuteCounts => storedMinutes.parse(item);

export const summaryOf = (item: Item): MonitorSummary => monitorSummary.parse(item);

/** A raw check item (`R#<scheduledAt>#<region>`, written by the evaluator) as a rollup reads it. */
export function rawCheckOf(item: Item): RawCheck {
  const [, scheduledAt = "", region = ""] = String(item.sk).split("#");
  const check = storedCheck.parse(item);
  return {
    region,
    scheduledAt,
    status: check.status,
    latencyMs: check.latencyMs ?? null,
    phases: check.phases ?? null,
  };
}
