"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ButtonLink } from "../../components/button.tsx";
import { StatusLabel } from "../../components/status.tsx";
import { api, unwrap } from "../../lib/api.ts";
import { Time } from "./incidents/incident-ui.tsx";
import { useTelemetry } from "./monitors/monitor-health.tsx";

const link = "text-[14px] underline-offset-2 hover:underline";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="border-b border-mist pb-2 text-[19px] font-semibold leading-[1.35]">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** What exists right now: monitors and their state, open incidents, the next maintenance. */
export function OverviewSummary() {
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => unwrap(api.GET("/v1/monitors")),
  });
  const telemetry = useTelemetry();
  const incidents = useQuery({
    queryKey: ["incidents", "open"],
    queryFn: () => unwrap(api.GET("/v1/incidents", { params: { query: { state: "open" } } })),
  });
  const windows = useQuery({
    queryKey: ["maintenances"],
    queryFn: () => unwrap(api.GET("/v1/maintenances")),
  });

  if (monitors.isPending || incidents.isPending || windows.isPending) {
    return <p className="mt-8 text-slate">Loading overview</p>;
  }
  const failed = monitors.error ?? incidents.error ?? windows.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;

  const list = monitors.data?.monitors ?? [];
  if (list.length === 0) {
    return (
      <section className="mt-8 flex max-w-[72ch] flex-col items-start gap-4 rounded-xl border border-mist bg-surface p-6">
        <p className="text-[16px] leading-[1.55]">
          No monitors yet. Add a URL and Galena checks it every minute from 3 regions.
        </p>
        <ButtonLink href="/dashboard/monitors/" variant="primary">
          Add monitor
        </ButtonLink>
      </section>
    );
  }

  const statusOf = (id: string) =>
    telemetry.data?.monitors.find((m) => m.id === id)?.status ?? null;
  const open = incidents.data?.incidents ?? [];
  const next = (windows.data?.maintenances ?? [])
    .filter((w) => w.status !== "completed")
    .toSorted((a, b) => a.startsAt.localeCompare(b.startsAt))[0];

  return (
    <>
      <Section
        id="overview-monitors"
        title={`${list.length} ${list.length === 1 ? "monitor" : "monitors"}`}
      >
        <ul>
          {list.map((m) => (
            <li
              key={m.id}
              className="flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist py-2"
            >
              <span className="font-semibold">{m.name}</span>
              {m.enabled ? (
                <StatusLabel status={statusOf(m.id)} />
              ) : (
                <span className="text-[14px] text-slate">Paused</span>
              )}
            </li>
          ))}
        </ul>
        <Link href="/dashboard/monitors/" className={`mt-3 inline-block ${link}`}>
          All monitors
        </Link>
      </Section>

      <Section id="overview-incidents" title="Open incidents">
        {open.length === 0 ? (
          <p className="py-3 text-[14px] text-slate">No open incidents.</p>
        ) : (
          <ul>
            {open.map((i) => (
              <li key={i.id} className="border-b border-mist py-2">
                <Link href={`/dashboard/incidents/view/?id=${i.id}`} className={link}>
                  {i.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="overview-maintenance" title="Maintenance">
        {next ? (
          <p className="py-3 text-[14px]">
            {next.title}: <Time iso={next.startsAt} /> to <Time iso={next.endsAt} />.
          </p>
        ) : (
          <p className="py-3 text-[14px] text-slate">Nothing scheduled.</p>
        )}
      </Section>
    </>
  );
}
