import type { CheckStatus, Labels, MonitorState } from "@galena/contracts";
import { incidentStatusLabels } from "@galena/contracts/copy";
import type { Mark } from "../../../../components/ui/minute-marks.tsx";
import type { Answer } from "../../../../lib/answer.ts";
import { regionName } from "../../../../lib/regions.ts";
import { utcClock } from "../../../../lib/time.ts";
import { latency } from "../../monitors/monitor-row.ts";

// What the incident page says about an incident's evidence, worked out from the API's answer.

export type IncidentDetail = Answer<"/v1/incidents/{id}">;
export type Evidence = Answer<"/v1/incidents/{id}/evidence">;
export type EvidenceMonitor = NonNullable<Evidence["monitor"]>;
type Result = EvidenceMonitor["results"][number];

const MINUTE = 60_000;
/** A probe's message as the end of a sentence. */
const sentence = (text: string) => `${text.replace(/\.$/, "")}.`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** Oldest first: ISO times in one format sort as text. */
export const byTime = (a: Result, b: Result) =>
  a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0;

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null);
}

/**
 * Each region's results, oldest first. A heartbeat is judged in the one region that sweeps it,
 * not by the probes, so its regions are the ones its results name.
 */
function byRegion(monitor: EvidenceMonitor) {
  const sorted = monitor.results.toSorted(byTime);
  const regions =
    monitor.type === "heartbeat" ? [...new Set(sorted.map((c) => c.region))] : monitor.regions;
  return new Map(regions.map((r) => [r, sorted.filter((c) => c.region === r)] as const));
}

/** A probe error says nothing about the target, as detection reads it. */
const said = (checks: readonly Result[]) => checks.filter((c) => c.status !== "error");

/**
 * The first failure of the run the incident opened on, in one region: the failures just before
 * the start, or else the first one after it; none if it had none.
 */
function runAtStart(checks: readonly Result[], startedAt: string) {
  const known = said(checks);
  let from = known.findLastIndex((c) => c.scheduledAt < startedAt) + 1;
  while (from > 0 && known[from - 1]?.status === "down") from--;
  return known.slice(from).find((c) => c.status === "down");
}

/** Every region's latest word is an answer. */
const allAnswering = (regions: ReadonlyMap<string, readonly Result[]>) =>
  [...regions.values()].every((checks) => {
    const latest = said(checks).at(-1);
    return latest !== undefined && latest.status !== "down";
  });

/** "Why it opened", in one or two sentences. */
export function triggerOf(incident: IncidentDetail, evidence: Evidence): string {
  const { monitor } = evidence;
  if (!monitor) {
    if (incident.source === "monitor") return "Opened by a monitor that has since been deleted.";
    const alert = evidence.timeline.find((e) => e.kind === "signal");
    if (alert?.kind === "signal") {
      const from = alert.integrationName ?? "a deleted integration";
      return `Opened from an alert: ${alert.title}, ${plural(alert.alertCount, "alert")}, from ${from}.`;
    }
    return incident.source === "signal"
      ? "Opened from an alert."
      : "Opened by a person, not a monitor.";
  }
  if (monitor.results.length === 0) return `${monitor.name} has no check results from that time.`;
  const regions = byRegion(monitor);
  const firsts = [...regions.values()]
    .flatMap((checks) => runAtStart(checks, incident.startedAt) ?? [])
    .toSorted(byTime);
  const first = firsts[0];
  const now = allAnswering(regions) ? `${monitor.name} is answering again in every region.` : "";
  if (!first) return now || `${monitor.name} has no failed checks around the start.`;
  const why = first.error ? `: ${sentence(first.error.message)}` : ".";
  const story =
    monitor.type === "heartbeat"
      ? `went down at ${utcClock(first.scheduledAt)}${why}`
      : `failed in ${firsts.length} of ${regions.size} regions from ${utcClock(first.scheduledAt)}${why}`;
  const usual = median(
    said(monitor.results).flatMap((r) =>
      r.scheduledAt < first.scheduledAt && r.latencyMs !== null ? [r.latencyMs] : [],
    ),
  );
  const before =
    usual === null || monitor.type === "heartbeat"
      ? ""
      : ` Before that it answered in ${latency(usual)}.`;
  return now ? `${now} It ${story}${before}` : `${monitor.name} ${story}${before}`;
}

const MARK_OF: Record<CheckStatus, Mark> = {
  up: "operational",
  degraded: "degraded_performance",
  down: "major_outage",
  error: "none",
};

/** One mark per minute from `from` to `to`, both included. */
function marks(checks: readonly Result[], from: string, to: string): Mark[] {
  const at = new Map(checks.map((c) => [Date.parse(c.scheduledAt), c]));
  const start = Math.ceil(Date.parse(from) / MINUTE) * MINUTE;
  const out: Mark[] = [];
  for (let t = start; t <= Date.parse(to); t += MINUTE) {
    const check = at.get(t);
    out.push(check ? MARK_OF[check.status] : "none");
  }
  return out;
}

export type RegionRow = {
  region: string;
  name: string;
  /** The minutes from the window's start, to the gap or its end. */
  head: Mark[];
  /** The latest minutes after a gap; null without one. */
  tail: Mark[] | null;
  /**
   * The current run of failures, as far as the results show; null while it answers. Nothing older
   * is known at the window's start or right after the gap, so there it may be older.
   */
  failing: { since: string; message: string | null; mayBeOlder: boolean } | null;
  /** Its latest answer; null while it fails or before any check. */
  latest: { ms: number | null; isDegraded: boolean } | null;
};

/** The per-region check grid. */
export function regionRows({ monitor }: Evidence): RegionRow[] {
  if (!monitor) return [];
  const { window } = monitor;
  return [...byRegion(monitor)].map(([region, checks]) => {
    // Only the part after the gap counts: the middle may hold answers no one read.
    const gapEnd = window.gap?.to ?? "";
    const part = said(checks).filter((c) => c.scheduledAt >= gapEnd);
    let run = part.length;
    while (run > 0 && part[run - 1]?.status === "down") run--;
    const since = part[run];
    const latest = part.at(-1);
    return {
      region,
      name: regionName(region),
      head: marks(checks, window.from, window.gap?.from ?? window.to),
      tail: window.gap ? marks(checks, window.gap.to, window.to) : null,
      failing: since
        ? { since: since.scheduledAt, message: since.error?.message ?? null, mayBeOlder: run === 0 }
        : null,
      latest:
        latest && !since
          ? { ms: latest.latencyMs, isDegraded: latest.status === "degraded" }
          : null,
    };
  });
}

export type Entry = {
  key: string;
  at: string;
  text: string;
  /** A paragraph under the line: an update's words, a delivery's error. */
  detail?: string;
  /** An alert group's alerts, by their labels. */
  labels?: Labels[];
};

const STATE_WORDS: Record<MonitorState, string> = {
  unknown: "has no data",
  up: "is up",
  degraded: "is slow",
  down: "is down",
  recovering: "is recovering",
  flapping: "is flapping",
};

const DELIVERY_WORDS = {
  pending: "waiting",
  sent: "delivered",
  failed: "failed",
  skipped: "skipped",
} as const;

function noticeEntry(notice: NonNullable<Evidence["notifications"]>[number]): Entry {
  const { pending, sent, failed, skipped } = notice.subscribers;
  const emails = pending + sent + failed + skipped;
  const parts: string[] = [];
  if (emails > 0) {
    const rest = [
      failed > 0 ? `${failed} failed` : "",
      pending > 0 ? `${pending} waiting` : "",
    ].filter(Boolean);
    parts.push(
      `${sent} of ${plural(emails, "subscriber email")} delivered${rest.length > 0 ? `, ${rest.join(", ")}` : ""}.`,
    );
  }
  for (const e of notice.endpoints) parts.push(`${e.name} ${DELIVERY_WORDS[e.status]}.`);
  const errors = notice.endpoints.flatMap((e) =>
    e.lastError ? [`${e.name}: ${e.lastError}`] : [],
  );
  return {
    key: `notice:${notice.eventId}`,
    at: notice.at,
    text: `Notice sent: ${parts.join(" ")}`,
    ...(errors.length > 0 ? { detail: errors.join("\n") } : {}),
  };
}

/**
 * Everything that happened, oldest first: when each region began failing, the monitor's state
 * changes, alert groups, updates (each carries its status, so status changes aren't listed again)
 * and notices.
 */
export function timelineOf(incident: IncidentDetail, evidence: Evidence): Entry[] {
  const name = evidence.monitor?.name ?? "The monitor";
  const isDraft = incident.visibility === "draft" || incident.visibility === "dismissed";
  const entries: Entry[] = [
    ...regionRows(evidence).flatMap((row) =>
      row.failing && !row.failing.mayBeOlder
        ? [
            {
              key: `region:${row.region}`,
              at: row.failing.since,
              text: `${row.name} (${row.region}) began failing`,
              ...(row.failing.message ? { detail: row.failing.message } : {}),
            },
          ]
        : [],
    ),
    ...(evidence.monitor?.transitions ?? []).map((t) => ({
      key: `state:${t.at}:${t.to}`,
      at: t.at,
      text: `${name} ${STATE_WORDS[t.to]}`,
    })),
    ...incident.updates.map((u) => ({
      key: u.id,
      at: u.createdAt,
      text: `${isDraft ? "Draft written" : "Update posted"}: ${incidentStatusLabels[u.status]}`,
      detail: u.body,
    })),
    ...evidence.timeline.flatMap((e) =>
      e.kind === "signal"
        ? [
            {
              key: `signal:${e.at}:${e.status}`,
              at: e.at,
              text: `Alert from ${e.integrationName ?? "a deleted integration"}: ${e.title} ${e.status}, ${plural(e.alertCount, "alert")}`,
              labels: e.alerts,
            },
          ]
        : [],
    ),
    ...(evidence.notifications ?? []).map(noticeEntry),
  ];
  // Stable: at the same minute, the monitor's change comes before the update it caused.
  return entries.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
