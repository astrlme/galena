"use client";

import { useId } from "react";
import { StateGlyph } from "../../../../components/status.tsx";
import { MinuteMarks } from "../../../../components/ui/minute-marks.tsx";
import { regionName } from "../../../../lib/regions.ts";
import { hm, utcClock, utcMinute } from "../../../../lib/time.ts";
import { latency } from "../../monitors/monitor-row.ts";
import { byTime, type Entry, type EvidenceMonitor, type RegionRow } from "./evidence.ts";

// The incident page's evidence, before any form: each region's minutes, response time around the
// start, and everything that happened.

/** A UTC time of day, with the reader's local time on hover. */
function Clock({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="tabular-nums">
      {utcClock(iso)}
    </time>
  );
}

/** One row per region: its minutes as marks, and in words whether it fails and since when. */
export function RegionGrid({
  rows,
  window,
  isResolved,
}: {
  rows: readonly RegionRow[];
  window: EvidenceMonitor["window"];
  isResolved: boolean;
}) {
  const gap = window.gap;
  const leftOut = gap ? hm((Date.parse(gap.to) - Date.parse(gap.from)) / 60_000) : "";
  return (
    <>
      <ul aria-label="Checks by region" className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.region}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4 gap-y-1 text-[14px] sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,210px)]"
          >
            <span>
              {row.name} <span className="text-slate">{row.region}</span>
            </span>
            <span className="order-last col-span-2 flex min-w-0 items-end gap-2 sm:order-none sm:col-span-1">
              <MinuteMarks marks={row.head} fit />
              {row.tail && (
                <>
                  <span className="shrink-0 text-[13px] text-slate">{leftOut} left out</span>
                  <MinuteMarks marks={row.tail} fit />
                </>
              )}
            </span>
            <RegionState row={row} />
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-[72ch] text-[13px] text-slate">
        One mark per minute, from 30 minutes before the start to{" "}
        {isResolved ? "the resolution" : "now"}
        {gap ? "; the middle of a long incident is left out" : ""}. A tall mark is a failed check.
      </p>
    </>
  );
}

function RegionState({ row }: { row: RegionRow }) {
  if (row.failing) {
    return (
      <span className="flex items-center gap-1.5 font-semibold tabular-nums">
        <StateGlyph status="major_outage" />
        <span>
          Failing since <Clock iso={row.failing.since} />
          {row.failing.mayBeOlder ? " or earlier" : ""}
        </span>
      </span>
    );
  }
  if (row.latest?.isDegraded) {
    return (
      <span className="flex items-center gap-1.5 tabular-nums">
        <StateGlyph status="degraded_performance" />
        Degraded performance{row.latest.ms === null ? "" : `, ${latency(row.latest.ms)}`}
      </span>
    );
  }
  return (
    <span className="text-right tabular-nums sm:text-left">
      {row.latest?.ms == null ? "No answers" : `Answering in ${latency(row.latest.ms)}`}
    </span>
  );
}

const W = 240;
const H = 64;

/**
 * Small multiples of response time around the start, one per region on a shared scale, the
 * incident hatched behind the line; a failed check leaves a gap in it.
 */
export function LatencyCharts({
  monitor,
  startedAt,
}: {
  monitor: EvidenceMonitor;
  startedAt: string;
}) {
  const end = monitor.window.gap?.from ?? monitor.window.to;
  const shown = monitor.results.filter((r) => r.scheduledAt <= end).toSorted(byTime);
  const top = Math.max(1, ...shown.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs])));
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {monitor.regions.map((region) => (
        <li key={region} className="flex min-w-0 flex-col gap-1">
          <span className="flex justify-between text-[13px] text-slate tabular-nums">
            <span>{regionName(region)}</span>
            <span>{latency(top)}</span>
          </span>
          <MiniChart
            checks={shown.filter((r) => r.region === region)}
            from={Date.parse(monitor.window.from)}
            to={Date.parse(end)}
            max={top * 1.15}
            started={Date.parse(startedAt)}
            name={regionName(region)}
          />
          <span className="flex justify-between text-[13px] text-slate tabular-nums">
            <span>{utcClock(monitor.window.from)}</span>
            <span>{utcClock(end)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function MiniChart({
  checks,
  from,
  to,
  max,
  started,
  name,
}: {
  checks: EvidenceMonitor["results"];
  from: number;
  to: number;
  max: number;
  started: number;
  name: string;
}) {
  const hatch = useId();
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (ms: number) => H - (ms / max) * H;
  const lines: string[] = [];
  let line = "";
  for (const c of checks) {
    if (c.latencyMs === null) {
      if (line) lines.push(line);
      line = "";
      continue;
    }
    line += `${line ? "L" : "M"}${x(Date.parse(c.scheduledAt)).toFixed(1)} ${y(c.latencyMs).toFixed(1)} `;
  }
  if (line) lines.push(line);
  const answers = checks.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const failed = checks.length - answers.length;
  const label =
    answers.length === 0
      ? `${name}: no answers`
      : `${name}: response time from ${latency(Math.min(...answers))} to ${latency(Math.max(...answers))}${failed > 0 ? `, no answer in ${failed} of ${checks.length} minutes` : ""}`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-16 w-full"
    >
      <defs>
        <pattern
          id={hatch}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1.5} className="stroke-ash" />
        </pattern>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="stroke-mist" />
      ))}
      {started <= to && (
        <rect
          x={x(Math.max(from, started))}
          y={0}
          width={W - x(Math.max(from, started))}
          height={H}
          fill={`url(#${hatch})`}
        />
      )}
      {lines.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className="stroke-ink"
        />
      ))}
      <line x1={0} x2={W} y1={H} y2={H} className="stroke-mist" />
    </svg>
  );
}

/** Everything that happened, oldest first: the time of day, or the date too after the first day. */
export function Timeline({ entries, startedAt }: { entries: readonly Entry[]; startedAt: string }) {
  const day = startedAt.slice(0, 10);
  return (
    <ol className="flex flex-col gap-3 text-[14px]">
      {entries.map((e) => (
        <li key={e.key} className="grid gap-x-4 gap-y-1 sm:grid-cols-[136px_minmax(0,1fr)]">
          <time
            dateTime={e.at}
            title={new Date(e.at).toLocaleString()}
            className="text-slate tabular-nums"
          >
            {e.at.slice(0, 10) === day ? utcClock(e.at) : utcMinute(e.at)}
          </time>
          <div className="flex min-w-0 max-w-[72ch] flex-col gap-1">
            <span>{e.text}</span>
            {e.detail && <p className="whitespace-pre-wrap text-graphite">{e.detail}</p>}
            {e.labels && e.labels.length > 0 && (
              <details className="text-graphite">
                <summary className="cursor-pointer">
                  Labels of {e.labels.length === 1 ? "the alert" : `${e.labels.length} alerts`}
                </summary>
                <ul className="mt-1 flex flex-col gap-1 font-mono text-[13px]">
                  {e.labels.map((labels, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: alerts keep their order and can repeat
                    <li key={i} className="[overflow-wrap:anywhere]">
                      {Object.entries(labels)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" ")}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
