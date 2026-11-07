import type { ComponentStatus, MonitorSummary } from "@galena/contracts";
import { labelOf } from "../../../components/status.tsx";
import type { Monitor } from "./monitor-form.tsx";
import { every, span } from "./schedule.ts";
import type { Reading, Result } from "./telemetry.tsx";

/** One monitor as the list shows it; a paused one carries no readings. */
export type Row = {
  id: string;
  monitor: Monitor;
  /** Why a reading is missing, for its cell: paused, or check results not read yet. */
  checks: "paused" | "loading" | "read";
  /** Null while detection has no opinion yet: "No data". */
  status: ComponentStatus | null;
  summary: MonitorSummary | null;
  /** Each region's latest result, in the regions' order. */
  regions: { region: string; result: Result | undefined }[];
  /** The newest result's scheduled minute; a heartbeat's newest check-in. */
  lastCheck: string | null;
};

/** What a monitor watches, in words: its URL, or a heartbeat's schedule. */
export function watches(monitor: Monitor) {
  const h = monitor.heartbeat;
  if (h) return `Checks in ${every(h.periodMinutes)}, with ${span(h.graceMinutes)} of grace`;
  return monitor.http?.url ?? "";
}

export function rowOf(
  monitor: Monitor,
  telemetry: { regions: string[]; monitors: Reading[] } | undefined,
): Row {
  const checks = !monitor.enabled ? "paused" : telemetry ? "read" : "loading";
  const reading =
    checks === "read" ? telemetry?.monitors.find((m) => m.id === monitor.id) : undefined;
  const results = reading?.results ?? [];
  const latest = new Map<string, Result>();
  for (const result of results) if (!latest.has(result.region)) latest.set(result.region, result);
  // A heartbeat has no probe regions: the sweeper judges it once a minute from its check-ins.
  const isHeartbeat = monitor.type === "heartbeat";
  return {
    id: monitor.id,
    monitor,
    checks,
    status: reading?.status ?? null,
    summary: reading?.summary ?? null,
    regions:
      checks === "read" && !isHeartbeat
        ? (telemetry?.regions ?? []).map((region) => ({ region, result: latest.get(region) }))
        : [],
    lastCheck: isHeartbeat ? (reading?.lastPingAt ?? null) : (results[0]?.scheduledAt ?? null),
  };
}

export const latency = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** The 30 days' share of minutes up, 0 to 1; undefined without any. */
export const uptimeOf = (summary: MonitorSummary | null) =>
  summary && summary.minutes > 0 ? 1 - summary.minutesDown / summary.minutes : undefined;

/** Two decimals, rounded down: a month with a minute down never reads 100.00%. */
export const percent = (share: number) => `${(Math.floor(share * 10_000) / 100).toFixed(2)}%`;

export function ago(iso: string, now: number) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

/** A region's latest check in the state vocabulary: a down check is that region's major outage. */
export function regionState(region: string, result: Result | undefined) {
  const status: ComponentStatus | null =
    !result || result.status === "error"
      ? null
      : result.status === "down"
        ? "major_outage"
        : result.status === "degraded"
          ? "degraded_performance"
          : "operational";
  const time = status && status !== "major_outage" && result?.latencyMs != null;
  const label = `${region}: ${labelOf(status)}${time ? `, ${latency(result.latencyMs ?? 0)}` : ""}`;
  return { status, label };
}
