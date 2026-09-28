"use client";

import { useQuery } from "@tanstack/react-query";
import { StatusLabel } from "../../../components/status.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";

type Telemetry =
  paths["/v1/monitors/telemetry"]["get"]["responses"][200]["content"]["application/json"];
export type Reading = Telemetry["monitors"][number];
type Result = Reading["results"][number];

const MINUTES = 60;
const MINUTE_MS = 60_000;

/** Checks run once a minute, so polling every 30 s while the page is open is fresh enough. */
export function useTelemetry() {
  return useQuery({
    queryKey: ["monitors", "telemetry"],
    queryFn: () => unwrap(api.GET("/v1/monitors/telemetry")),
    refetchInterval: 30_000,
  });
}

const latency = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

function RegionValue({ result }: { result: Result | undefined }) {
  if (result?.status === "down") return "Down";
  if (!result || result.status === "error" || result.latencyMs === null) {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">No data</span>
      </>
    );
  }
  return latency(result.latencyMs);
}

// One mark per minute, the worst across regions, in the state vocabulary's heights and inks.
type Mark = "operational" | "degraded" | "partial" | "major" | "none";
const MARKS: Record<Exclude<Mark, "none">, { height: number; fill: string }> = {
  operational: { height: 5, fill: "fill-slate" },
  degraded: { height: 12, fill: "fill-slate" },
  partial: { height: 19, fill: "fill-graphite" },
  major: { height: 27, fill: "fill-ink" },
};

function markOf(results: readonly Result[]): Mark {
  const reported = results.filter((r) => r.status !== "error");
  const down = reported.filter((r) => r.status === "down").length;
  if (reported.length === 0) return "none";
  if (down === reported.length) return "major";
  if (down > 0) return "partial";
  return reported.some((r) => r.status === "degraded") ? "degraded" : "operational";
}

/** The newest minute with results and the 59 before it, oldest first. */
function minuteMarks(results: readonly Result[]): Mark[] {
  const newest = Math.max(0, ...results.map((r) => Date.parse(r.scheduledAt)));
  const byMinute = Map.groupBy(results, (r) => Date.parse(r.scheduledAt));
  return Array.from({ length: MINUTES }, (_, i) =>
    markOf(byMinute.get(newest - (MINUTES - 1 - i) * MINUTE_MS) ?? []),
  );
}

function describe(marks: readonly Mark[]) {
  const count = (...kinds: Mark[]) => marks.filter((m) => kinds.includes(m)).length;
  const parts = [
    [count("operational", "degraded"), "up"],
    [count("partial"), "down in some regions"],
    [count("major"), "down everywhere"],
    [count("none"), "without results"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return `Last ${MINUTES} minutes: ${said.join(", ")}.`;
}

function ResultStrip({ results }: { results: readonly Result[] }) {
  const marks = minuteMarks(results);
  const width = MINUTES * 6 - 2;
  return (
    <figure className="flex flex-col gap-1">
      <svg role="img" aria-label={describe(marks)} width={width} height={28}>
        <rect x={0} y={27} width={width} height={1} className="fill-mist" />
        {marks.map((mark, i) => {
          const x = i * 6;
          if (mark === "none") {
            // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
            return <rect key={i} x={x + 1.5} y={26} width={1} height={1} className="fill-ash" />;
          }
          const { height, fill } = MARKS[mark];
          // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
          return <rect key={i} x={x} y={27 - height} width={4} height={height} className={fill} />;
        })}
      </svg>
      <figcaption className="flex justify-between text-[13px] text-slate">
        <span>60 minutes ago</span>
        <span>Latest check</span>
      </figcaption>
    </figure>
  );
}

/** State, each region's latest latency and the last hour of checks for one monitor. */
export function MonitorHealth({
  reading,
  regions,
}: {
  reading: Reading | undefined;
  regions: readonly string[];
}) {
  const results = reading?.results ?? [];
  const latest = new Map<string, Result>();
  for (const result of results) if (!latest.has(result.region)) latest.set(result.region, result);
  return (
    <div className="flex basis-full flex-wrap items-center gap-x-6 gap-y-2">
      <StatusLabel status={reading?.status ?? null} />
      <dl className="flex gap-4 text-[14px] tabular-nums">
        {regions.map((region) => (
          <div key={region} className="flex flex-col">
            <dt className="text-slate">{region}</dt>
            <dd>
              <RegionValue result={latest.get(region)} />
            </dd>
          </div>
        ))}
      </dl>
      <ResultStrip results={results} />
    </div>
  );
}
