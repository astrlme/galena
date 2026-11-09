import { type SeriesRange, seriesRanges } from "@galena/contracts";
import { seriesWindow } from "@galena/core";
import type { Answer } from "../answer.ts";
import { spans } from "../time.ts";
import type { demoData } from "./data.ts";

// A demo monitor's page: the same gentle daily curve for every range, each region a little
// slower than the last, a few short outages in the 90 days, and the last hour from the list's
// own results. Deterministic, so every visit tells the same story.

type Data = ReturnType<typeof demoData>;
const DAY = 86_400_000;

/** The answer to GET /v1/monitors/{id}/series, /days or /checks for a demo monitor. */
export function monitorAnswer(
  data: Data,
  monitorId: string,
  part: string,
  asked: string | null,
  now: Date,
) {
  const index = Math.max(
    0,
    data.monitors.monitors.findIndex((m) => m.id === monitorId),
  );
  const reading = data.telemetry.monitors[index];
  const base = reading?.summary?.hourlyMedianMs[23] ?? 100;

  if (part === "checks") {
    return {
      regions: data.telemetry.regions,
      results: (reading?.results ?? []).map((r) => ({
        ...r,
        error:
          r.status === "down"
            ? { code: "timeout" as const, message: "No complete response within 10000 ms." }
            : null,
      })),
    } satisfies Answer<"/v1/monitors/{id}/checks">;
  }

  if (part === "days") {
    const today = Math.floor(now.getTime() / DAY) * DAY;
    return {
      days: Array.from({ length: 90 }, (_, i) => {
        const date = new Date(today - (89 - i) * DAY).toISOString().slice(0, 10);
        const minutes = i === 89 ? Math.floor((now.getTime() - today) / 60_000) : 1440;
        const down = (i * 7 + index * 5) % 37 === 0 ? 12 + index * 9 : 0;
        return { date, minutes, minutesDown: Math.min(down, minutes) };
      }),
      incidents: [],
    } satisfies Answer<"/v1/monitors/{id}/days">;
  }

  const range: SeriesRange = seriesRanges.find((r) => r === asked) ?? "24h";
  const window = seriesWindow(range, now);
  const keys = spans(window.source, window.from, window.to);
  const checks = window.source === "hour" ? 60 : 1440;
  const points = keys.flatMap((at, k) =>
    data.telemetry.regions.map((region, r) => {
      const median = Math.round(
        base * (1 + 0.15 * Math.sin(((k + index) / 24) * 2 * Math.PI)) + r * 14,
      );
      return {
        at,
        region,
        checks,
        down: 0,
        medianMs: median,
        p95Ms: Math.round(median * 1.5),
        maxMs: Math.round(median * 2.4),
        phases: { dns: 6, connect: 14, tls: 28, ttfb: median - 40 },
      };
    }),
  );
  const total = (region: string | null) => {
    const mine = points.filter((p) => region === null || p.region === region);
    const sorted = mine.map((p) => p.medianMs).toSorted((a, b) => a - b);
    return {
      region,
      checks: mine.length * checks,
      down: 0,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
      p95Ms: Math.max(...mine.map((p) => p.p95Ms)),
      maxMs: Math.max(...mine.map((p) => p.maxMs)),
      phases: { dns: 6, connect: 14, tls: 28, ttfb: (sorted[0] ?? 40) - 40 },
    };
  };
  return {
    range,
    step: window.source,
    from: window.from,
    to: window.to,
    points,
    totals: [...data.telemetry.regions.toSorted().map(total), total(null)],
    uptime: { minutes: (points.length * checks) / data.telemetry.regions.length, minutesDown: 0 },
    incidents: [],
  } satisfies Answer<"/v1/monitors/{id}/series">;
}
