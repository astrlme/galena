import type { paths } from "../../../../lib/api-schema.ts";
import { hm } from "../../../../lib/time.ts";

export type UptimeReport =
  paths["/v1/reports/uptime"]["get"]["responses"][200]["content"]["application/json"];

type Budget = NonNullable<UptimeReport["monitors"][number]["budget"]>;

/** The share of checked minutes up, 0 to 1; undefined without any. */
export const shareUp = (r: { minutes: number; minutesDown: number }) =>
  r.minutes === 0 ? undefined : 1 - r.minutesDown / r.minutes;

export const budgetText = ({ allowedMinutes, leftMinutes }: Budget) =>
  leftMinutes >= 0
    ? `${hm(leftMinutes)} left of ${hm(allowedMinutes)}`
    : `${hm(-leftMinutes)} over a ${hm(allowedMinutes)} budget`;

/** The month and the `count - 1` before it, newest first, as the month picker lists them (UTC). */
export function monthsBefore(now: Date, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return {
      value: first.toISOString().slice(0, 7),
      label: first.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  });
}

/**
 * A spreadsheet cell: quoted when it holds a comma, quote or line break, and with a leading `'`
 * when it would start a formula, since names are typed by people.
 */
function cell(value: string | number | null) {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Three decimals, rounded down like the page's two: a month with a minute down never reads 100.
 * In whole numbers, so 332 of 1,000 minutes down reads 66.800, not 66.799.
 */
const uptime = (minutes: number, down: number) =>
  minutes === 0 ? null : (Math.floor(((minutes - down) * 100_000) / minutes) / 1000).toFixed(3);

/** The report as RFC 4180 CSV: monitors, then components. */
export function reportCsv(report: UptimeReport) {
  const rows = [
    [
      "kind",
      "name",
      "month",
      "minutes_checked",
      "minutes_down",
      "uptime_percent",
      "incidents",
      "p95_ms",
      "sla_target_percent",
      "budget_allowed_minutes",
      "budget_left_minutes",
    ],
    ...report.monitors.map((m) => [
      "monitor",
      m.name,
      report.month,
      m.minutes,
      m.minutesDown,
      uptime(m.minutes, m.minutesDown),
      m.incidents,
      m.p95Ms,
      m.slaTarget,
      m.budget?.allowedMinutes ?? null,
      m.budget?.leftMinutes ?? null,
    ]),
    ...report.components.map((c) => [
      "component",
      c.name,
      report.month,
      c.minutes,
      c.minutesDown,
      uptime(c.minutes, c.minutesDown),
      c.incidents,
      null,
      null,
      null,
      null,
    ]),
  ];
  return rows.map((row) => `${row.map(cell).join(",")}\r\n`).join("");
}
