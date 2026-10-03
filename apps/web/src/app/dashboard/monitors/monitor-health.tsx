"use client";

import { useQuery } from "@tanstack/react-query";
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
  operational: { height: 5, fill: "fill-operational" },
  degraded: { height: 12, fill: "fill-degraded" },
  partial: { height: 19, fill: "fill-partial" },
  major: { height: 27, fill: "fill-major" },
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
    // Narrower than the strip, the oldest minutes are cropped on the left; the latest stay.
    <figure className="flex min-w-0 max-w-full flex-col gap-1">
      <div className="flex justify-end overflow-hidden">
        <svg role="img" aria-label={describe(marks)} width={width} height={28} className="shrink-0">
          <rect x={0} y={27} width={width} height={1} className="fill-mist" />
          {marks.map((mark, i) => {
            const x = i * 6;
            if (mark === "none") {
              // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
              return <rect key={i} x={x + 1.5} y={26} width={1} height={1} className="fill-ash" />;
            }
            const { height, fill } = MARKS[mark];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: one mark per fixed minute slot
              <rect key={i} x={x} y={27 - height} width={4} height={height} className={fill} />
            );
          })}
        </svg>
      </div>
      <figcaption className="flex justify-between text-[13px] text-slate">
        <span>
          <span className="hidden sm:inline">60 minutes ago</span>
          <span className="sm:hidden">Earlier</span>
        </span>
        <span>Latest check</span>
      </figcaption>
    </figure>
  );
}

/** Each region's latest latency and the last hour of checks for one monitor. */
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
    // `min-w-0`, or the strip's full width would hold the row open on a phone.
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-6 gap-y-2">
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
