"use client";

import type { ComponentStatus } from "@galena/contracts";
import {
  describeMarks,
  MinuteMarks,
  quorumMarks,
} from "../../../../components/ui/minute-marks.tsx";
import type { paths } from "../../../../lib/api-schema.ts";
import { two } from "../../../../lib/time.ts";
import { latency } from "../monitor-row.ts";

type Check =
  paths["/v1/monitors/{id}/checks"]["get"]["responses"][200]["content"]["application/json"]["results"][number];

const MINUTES = 60;
const hhmm = (iso: string) => {
  const at = new Date(iso);
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
};

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
  const marks = quorumMarks(results, quorum, downStatus, MINUTES);
  const failed = results.filter((r) => r.status === "down" || r.status === "error");
  return (
    <>
      {/* Narrower than the strip, the oldest minutes are cropped on the left; the latest stay. */}
      <figure className="flex w-fit min-w-0 max-w-full flex-col gap-1">
        <div className="flex justify-end overflow-hidden">
          <MinuteMarks marks={marks} label={describeMarks(marks)} />
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
