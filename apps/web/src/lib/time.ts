// Times as the dashboard writes them: UTC, with a span key for each hour or day of a chart.

export const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
export const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
export const two = (n: number) => String(n).padStart(2, "0");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "23h 8m", "52m", "24h". */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "2 Nov, 14:07 UTC" */
export function utcMinute(iso: string) {
  const at = new Date(iso);
  return `${at.getUTCDate()} ${SHORT_MONTHS[at.getUTCMonth()]}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

/** A span key's start in epoch ms: `YYYY-MM-DDTHH` (an hour) or `YYYY-MM-DD` (a day). */
export const startOf = (at: string) =>
  Date.parse(at.length === 13 ? `${at}:00:00.000Z` : `${at}T00:00:00.000Z`);

/** Every span key from `from` to `to`, inclusive: a chart's whole x axis, gaps included. */
export function spans(step: "hour" | "day", from: string, to: string): string[] {
  const unit = step === "hour" ? HOUR : DAY;
  const length = step === "hour" ? 13 : 10;
  const keys: string[] = [];
  for (let t = startOf(from); t <= startOf(to); t += unit) {
    keys.push(new Date(t).toISOString().slice(0, length));
  }
  return keys;
}

/** "2 Nov, 14:00 UTC" for an hour, "2 Nov" for a day. */
export function spanLabel(at: string) {
  const t = new Date(startOf(at));
  const day = `${t.getUTCDate()} ${SHORT_MONTHS[t.getUTCMonth()]}`;
  return at.length === 13 ? `${day}, ${at.slice(11)}:00 UTC` : day;
}
