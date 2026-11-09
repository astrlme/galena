import { utcClock } from "../../lib/time.ts";

/** A UTC time of day, "14:07 UTC", with the reader's local time on hover. */
export function UtcClock({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="tabular-nums">
      {utcClock(iso)}
    </time>
  );
}
