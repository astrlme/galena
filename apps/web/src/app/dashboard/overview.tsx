"use client";

import { useQuery } from "@tanstack/react-query";
import { Clock, FilePen, ShieldAlert, Unplug } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "../../components/button.tsx";
import { GlyphOnly, StateGlyph, StatusLabel } from "../../components/status.tsx";
import { Countdown, useNow } from "../../components/ui/live-time.tsx";
import { Loading } from "../../components/ui/loading.tsx";
import { describeMarks, MinuteMarks, quorumMarks } from "../../components/ui/minute-marks.tsx";
import { UtcClock } from "../../components/ui/utc-clock.tsx";
import { api, unwrap } from "../../lib/api.ts";
import { compareIso, utcClock } from "../../lib/time.ts";
import {
  activityOf,
  type HomeData,
  incidentPage,
  monitorPage,
  type Need,
  needsOf,
} from "./home.ts";
import { STATUS_LABELS, Time } from "./incidents/incident-ui.tsx";
import { useExpiries } from "./monitors/expiries.tsx";
import { ago } from "./monitors/monitor-row.ts";
import { PausedNotice, useTelemetry } from "./monitors/telemetry.tsx";

// Home: what needs a person and the open incidents at reading width, the state of things in a
// rail beside them. Approving happens on the incident page, never here.

/** Home's rail shows each monitor's last half hour. */
const RAIL_MINUTES = 30;
const card = "rounded-xl border border-mist bg-surface";
const link = "underline-offset-2 hover:underline";

function useHome() {
  // Known limit: every monitor's last 30 minutes on each poll (30 minutes × 3 regions, 90 items a
  // monitor every 30 s while someone is on Home); with many monitors, read the rail from a
  // per-minute summary item instead.
  const telemetry = useTelemetry(RAIL_MINUTES);
  const { interval } = telemetry;
  const me = useQuery({ queryKey: ["me"], queryFn: () => unwrap(api.GET("/v1/me")) });
  // Destinations are admin-only, like everywhere else.
  const canSeeDestinations = me.data?.role === "owner" || me.data?.role === "admin";
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => unwrap(api.GET("/v1/monitors")),
    refetchInterval: interval,
  });
  const open = useQuery({
    queryKey: ["incidents", "open"],
    queryFn: () => unwrap(api.GET("/v1/incidents", { params: { query: { state: "open" } } })),
    refetchInterval: interval,
  });
  const resolved = useQuery({
    queryKey: ["incidents", "resolved"],
    queryFn: () => unwrap(api.GET("/v1/incidents", { params: { query: { state: "resolved" } } })),
    refetchInterval: interval,
  });
  const endpoints = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: () => unwrap(api.GET("/v1/webhook-endpoints")),
    enabled: canSeeDestinations,
    refetchInterval: interval,
  });
  // The scan runs hourly: read once, with a five-minute staleness.
  const expiries = useExpiries();
  const windows = useQuery({
    queryKey: ["maintenances"],
    queryFn: () => unwrap(api.GET("/v1/maintenances")),
    refetchInterval: interval,
  });
  // The page needs these; the rest (resolved incidents, destinations, expiries, maintenance) only
  // add to it, so one of them failing leaves the rest of Home in place.
  const needed = [me, monitors, telemetry, open];
  return {
    pending: needed.some((q) => q.isPending),
    error: needed.find((q) => q.error)?.error ?? null,
    updatedAt: telemetry.dataUpdatedAt,
    paused: telemetry.paused,
    dataAt: (now: number): HomeData => ({
      now,
      incidents: open.data?.incidents ?? [],
      resolved: resolved.data?.incidents ?? [],
      monitors: monitors.data?.monitors ?? [],
      readings: telemetry.data?.monitors ?? [],
      endpoints: canSeeDestinations ? (endpoints.data ?? []) : null,
      expiries: expiries.data?.expiries ?? [],
    }),
    nextMaintenance: (windows.data?.maintenances ?? [])
      .filter((w) => w.status === "scheduled" || w.status === "in_progress")
      .toSorted((a, b) => compareIso(a.startsAt, b.startsAt))[0],
  };
}

const title = <h1 className="text-[24px] leading-[1.25] font-semibold">Home</h1>;

export function HomeView() {
  const home = useHome();
  // Once a minute is enough for "stale" and the needs list; countdowns tick on their own.
  const now = useNow(60_000);
  if (home.pending) {
    return (
      <>
        {title}
        <Loading label="Loading Home" />
      </>
    );
  }
  if (home.error) {
    return (
      <>
        {title}
        <p className="mt-8 font-semibold">Couldn't load Home. {home.error.message}</p>
      </>
    );
  }
  const data = home.dataAt(now);
  const needs = needsOf(data);
  const open = data.incidents.filter((i) => i.visibility !== "draft");

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 max-w-[760px] flex-col gap-6">
        <header className="flex flex-col gap-1">
          {title}
          <Summary needs={needs.length} data={data} />
        </header>
        {needs.length > 0 && (
          <section aria-labelledby="needs-you">
            <h2 id="needs-you" className="sr-only">
              Needs you
            </h2>
            <ol className="flex flex-col gap-3">
              {needs.map((need, i) => (
                <NeedCard key={need.key} need={need} isFirst={i === 0} />
              ))}
            </ol>
          </section>
        )}
        <section aria-labelledby="open-incidents" className="flex flex-col gap-2">
          <h2 id="open-incidents" className="text-[19px] leading-[1.35] font-semibold">
            Open incidents
          </h2>
          {open.length === 0 ? (
            <p className="text-[14px] text-slate">No open incidents.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {open.map((i) => (
                <li key={i.id}>
                  <Link
                    href={incidentPage(i.id)}
                    className={`${card} flex flex-col gap-1 px-4 py-3 hover:border-slate`}
                  >
                    <span className="font-semibold">{i.title}</span>
                    <span className="text-[14px] text-slate tabular-nums">
                      {STATUS_LABELS[i.status]}. Started <UtcClock iso={i.startedAt} />, updated{" "}
                      {ago(i.updatedAt, now).toLowerCase()}.
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside
        aria-label="State of things"
        className="flex flex-col gap-6 lg:border-l lg:border-mist lg:pl-8"
      >
        <div className="flex flex-col gap-1">
          <Updated at={home.updatedAt} />
          <PausedNotice paused={home.paused} />
        </div>
        <Rail data={data} />
        <RailSection id="next-maintenance" title="Next maintenance">
          {home.nextMaintenance ? (
            <p className="text-[14px]">
              <span className="font-semibold">{home.nextMaintenance.title}</span>
              <br />
              <Time iso={home.nextMaintenance.startsAt} /> to{" "}
              <Time iso={home.nextMaintenance.endsAt} />
            </p>
          ) : (
            <p className="text-[14px] text-slate">Nothing scheduled.</p>
          )}
        </RailSection>
        <RailSection id="recent-activity" title="Recent activity">
          <Activity data={data} />
        </RailSection>
      </aside>
    </div>
  );
}

/**
 * How many things need the person, or that none do; and how many of the running monitors are
 * operational, with the ✓ only when all are. A paused monitor isn't counted.
 */
function Summary({ needs, data }: { needs: number; data: HomeData }) {
  const status = new Map(data.readings.map((r) => [r.id, r.status]));
  const running = data.monitors.filter((m) => m.enabled);
  const fine = running.filter((m) => status.get(m.id) === "operational").length;
  const isAllFine = running.length > 0 && fine === running.length;
  const monitors =
    running.length === 0
      ? ""
      : isAllFine
        ? ` All ${running.length} ${running.length === 1 ? "monitor" : "monitors"} operational.`
        : ` ${fine} of ${running.length} monitors operational.`;
  const said =
    needs > 0
      ? `${needs} ${needs === 1 ? "thing needs" : "things need"} you, most urgent first.`
      : "Nothing needs you.";
  return (
    <p className="flex items-center gap-2 text-[16px]">
      {needs === 0 && isAllFine && <StateGlyph status="operational" />}
      <span>
        {said}
        {monitors}
      </span>
    </p>
  );
}

const KIND_ICONS = { draft: FilePen, destination: Unplug, expiry: ShieldAlert, stale: Clock };

function NeedCard({ need, isFirst }: { need: Need; isFirst: boolean }) {
  const Icon = need.kind === "down" ? null : KIND_ICONS[need.kind];
  return (
    <li className={`${card} flex flex-col gap-3 p-4`}>
      <span className="flex items-center gap-2 text-[14px] text-graphite">
        {Icon && <Icon aria-hidden="true" size={16} strokeWidth={1.5} />}
        {need.label}
        {need.status && <StatusLabel status={need.status} />}
      </span>
      <h3 className="text-[19px] leading-[1.35] font-semibold [overflow-wrap:anywhere]">
        <Link href={need.action.href} className={link}>
          {need.title}
        </Link>
      </h3>
      <p className="max-w-[72ch] text-[14px] tabular-nums">
        {need.deadline ? (
          <>
            Publishes automatically at <UtcClock iso={need.deadline} />, in{" "}
            <Countdown deadline={need.deadline} className="font-semibold" />, unless you approve or
            dismiss it sooner.
          </>
        ) : (
          need.detail
        )}
      </p>
      <div>
        <ButtonLink href={need.action.href} variant={isFirst ? "primary" : "secondary"}>
          {need.action.label}
        </ButtonLink>
      </div>
    </li>
  );
}

function Updated({ at }: { at: number }) {
  const now = useNow();
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return (
    <span className="text-[14px] text-slate tabular-nums">
      Updated {seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`} ago
    </span>
  );
}

function RailSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-[16px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Each monitor's state and its last 30 minutes, a minute down where its quorum of regions failed. */
function Rail({ data }: { data: HomeData }) {
  const readings = new Map(data.readings.map((r) => [r.id, r]));
  return (
    <RailSection id="rail-monitors" title="Monitors">
      {data.monitors.length === 0 ? (
        <p className="text-[14px] text-slate">
          No monitors yet.{" "}
          <Link href="/dashboard/monitors/" className={link}>
            Add a monitor
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col">
          {data.monitors.map((m) => {
            const reading = readings.get(m.id);
            const marks = quorumMarks(
              reading?.results ?? [],
              m.detection.quorum,
              m.downStatus,
              RAIL_MINUTES,
            );
            return (
              <li
                key={m.id}
                className="flex min-h-11 items-center justify-between gap-3 border-b border-mist text-[14px] lg:min-h-9"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {m.enabled ? (
                    <GlyphOnly status={reading?.status ?? null} />
                  ) : (
                    <span className="text-slate">Paused</span>
                  )}
                  <Link href={monitorPage(m.id)} title={m.name} className={`truncate ${link}`}>
                    {m.name}
                  </Link>
                </span>
                {m.enabled && (
                  <MinuteMarks marks={marks} label={`${m.name}. ${describeMarks(marks)}`} small />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
}

function Activity({ data }: { data: HomeData }) {
  const events = activityOf(data);
  if (events.length === 0) return <p className="text-[14px] text-slate">Nothing yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5 text-[14px]">
      {events.map((e) => (
        <li key={e.key} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
          <time
            dateTime={e.at}
            title={new Date(e.at).toLocaleString()}
            className="text-slate tabular-nums"
          >
            {utcClock(e.at)}
          </time>
          <span className="[overflow-wrap:anywhere]">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}
