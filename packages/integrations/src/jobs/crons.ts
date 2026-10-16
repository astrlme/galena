/**
 * The scheduled jobs, in cron syntax (UTC), for every engine. The sweep and the rollup share a
 * minute so Aurora wakes once; each wake costs about ten minutes of capacity.
 */
export const cronPatterns = {
  "outbox.sweep": "5 */6 * * *",
  "rollup.uptime": "5 */6 * * *",
  "page.heartbeat": "35 * * * *",
} as const;

/**
 * A five-field pattern as an EventBridge Scheduler expression (six fields, `?` for the weekday,
 * `0/n` for a step). Known limit: only minute and hour may be set, as in every schedule here; a
 * daily or weekly job would map day, month and weekday too (Scheduler takes `?` in one of them).
 */
export function schedulerCron(pattern: string): string {
  const [minute = "", hour = "", ...rest] = pattern.split(" ");
  if (rest.length !== 3 || rest.some((field) => field !== "*")) {
    throw new Error(`Only minute and hour are read in "${pattern}"; the other fields must be *.`);
  }
  const step = (field: string) => field.replace(/^\*\//, "0/");
  return `cron(${step(minute)} ${step(hour)} * * ? *)`;
}
