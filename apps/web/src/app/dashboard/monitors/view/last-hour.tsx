"use client";

import type { ComponentStatus } from "@galena/contracts";
import { componentStatusLabels } from "@galena/contracts/copy";
import { type Mark, MinuteMarks } from "../../../../components/ui/minute-marks.tsx";
import type { paths } from "../../../../lib/api-schema.ts";
import { two } from "../../../../lib/time.ts";
import { latency } from "../monitor-row.ts";

type Check =
  paths["/v1/monitors/{id}/checks"]["get"]["responses"][200]["content"]["application/json"]["results"][number];

const MINUTES = 60;
const MINUTE_MS = 60_000;
const hhmm = (iso: string) => {
  const at = new Date(iso);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
};

// A minute is down only when the monitor's quorum of regions failed it, as the uptime bar counts
// it; a failure in fewer regions is in the list below, not an outage.

function markOf(results: readonly Check[], quorum: number, downStatus: ComponentStatus): Mark {
  const reported = results.filter((r) => r.status !== "error");
  if (reported.length === 0) return "none";
  if (reported.filter((r) => r.status === "down").length >= quorum) return downStatus;
  return reported.some((r) => r.status === "degraded") ? "degraded_performance" : "operational";
}

/** The newest minute with results and the 59 before it, oldest first. */
function minuteMarks(results: readonly Check[], quorum: number, downStatus: ComponentStatus) {
  const newest = Math.max(0, ...results.map((r) => Date.parse(r.scheduledAt)));
  const byMinute = Map.groupBy(results, (r) => Date.parse(r.scheduledAt));
  return Array.from({ length: MINUTES }, (_, i) =>
    markOf(byMinute.get(newest - (MINUTES - 1 - i) * MINUTE_MS) ?? [], quorum, downStatus),
  );
}

/** "Last 60 minutes: 56 operational, 3 degraded performance, 1 major outage." */
function describe(marks: readonly Mark[]) {
  const counts = new Map<Mark, number>();
  for (const mark of marks) counts.set(mark, (counts.get(mark) ?? 0) + 1);
  const said = [...counts].map(
    ([mark, n]) =>
      `${n} ${mark === "none" ? "without results" : componentStatusLabels[mark].toLowerCase()}`,
  );
  return `Last ${MINUTES} minutes: ${said.join(", ")}.`;
}

/**
 * The monitor's last hour: one mark per minute, then every check that failed in it, newest
 * first, with the probe's own words for why.
 */
export function LastHour({
  results,
  quorum,
  downStatus,
  regions = true,
}: {
  results: readonly Check[];
  quorum: number;
  /** The state the monitor marks while down. */
  downStatus: ComponentStatus;
  /** False for a heartbeat, judged in one place: its failures name no region. */
  regions?: boolean;
}) {
  const marks = minuteMarks(results, quorum, downStatus);
  const failed = results.filter((r) => r.status === "down" || r.status === "error");
  return (
    <>
      {/* Narrower than the strip, the oldest minutes are cropped on the left; the latest stay. */}
      <figure className="flex w-fit min-w-0 max-w-full flex-col gap-1">
        <div className="flex justify-end overflow-hidden">
          <MinuteMarks marks={marks} label={describe(marks)} />
        </div>
        <figcaption className="flex justify-between text-[13px] text-slate">
          <span>
            <span className="hidden sm:inline">60 minutes ago</span>
            <span className="sm:hidden">Earlier</span>
          </span>
          <span>Latest check</span>
        </figcaption>
      </figure>
      <h3 className="mt-6 text-[16px] font-semibold">Failed checks</h3>
      {failed.length === 0 ? (
        <p className="mt-2 text-[14px] text-slate">
          {results.length === 0 ? "No checks in the last hour." : "None in the last hour."}
        </p>
      ) : (
        <ul className="mt-2 rounded-xl border border-mist bg-surface text-[14px]">
          {failed.map((r) => (
            <li
              key={`${r.scheduledAt} ${r.region}`}
              className="flex flex-wrap gap-x-4 gap-y-1 border-b border-mist px-4 py-2 last:border-b-0"
            >
              <time
                dateTime={r.scheduledAt}
                title={new Date(r.scheduledAt).toLocaleString()}
                className="tabular-nums"
              >
                {hhmm(r.scheduledAt)} UTC
              </time>
              {regions && <span>{r.region}</span>}
              <span className="text-slate">
                {r.status === "error" ? "Probe error" : "Down"}
                {r.latencyMs !== null ? ` after ${latency(r.latencyMs)}` : ""}
                {r.error ? `: ${r.error.message}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
