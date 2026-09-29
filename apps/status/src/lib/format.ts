// Times on the page are UTC, written the same way everywhere.

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const two = (n: number) => String(n).padStart(2, "0");

/** "14:02 UTC" */
export const utcTime = (iso: string) => {
  const at = new Date(iso);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
};

/** "12 Sep" */
export const utcDay = (iso: string) => {
  const at = new Date(iso);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
};

/** "12 Sep, 14:02 UTC" */
export const utcDateTime = (iso: string) => `${utcDay(iso)}, ${utcTime(iso)}`;

/** "42 minutes", "1 hour", "2 hours 5 minutes", "3 days 4 hours" */
export function duration(fromIso: string, toIso: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return [unit(hours, "hour"), minutes % 60 ? unit(minutes % 60, "minute") : ""].join(" ").trim();
  const days = Math.floor(hours / 24);
  return [unit(days, "day"), hours % 24 ? unit(hours % 24, "hour") : ""].join(" ").trim();
}
