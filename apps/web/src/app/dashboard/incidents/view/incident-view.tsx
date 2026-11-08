"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { StatusLabel } from "../../../../components/status.tsx";
import { Loading } from "../../../../components/ui/loading.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import {
  IMPACT_LABELS,
  IMPACT_TITLE,
  STATUS_LABELS,
  Time,
  VisibilityNote,
} from "../incident-ui.tsx";
import { type IncidentDetail, regionRows, timelineOf, triggerOf } from "./evidence.ts";
import { LatencyCharts, RegionGrid, Timeline } from "./evidence-sections.tsx";
import { IncidentPanel } from "./incident-panel.tsx";

const h2 = "text-[19px] font-semibold leading-[1.35]";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className={h2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function IncidentView() {
  const id = useSearchParams().get("id") ?? "";
  const incident = useQuery({
    queryKey: ["incidents", id],
    queryFn: () => unwrap(api.GET("/v1/incidents/{id}", { params: { path: { id } } })),
    enabled: id !== "",
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });

  if (id === "") return <p className="mt-8 font-semibold">This link has no incident in it.</p>;
  if (incident.isPending || components.isPending) {
    return <Loading label="Loading incident" />;
  }
  const failed = incident.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const nameOf = (componentId: string) =>
    all.find((c) => c.id === componentId)?.name ?? "A deleted component";
  const shown = incident.data;
  if (!shown) return null;

  return (
    // Room at the foot for the phone's sheet.
    <div className="flex flex-col gap-6 pb-48 sm:pb-0">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/incidents/"
          className="text-[14px] underline-offset-2 hover:underline"
        >
          All incidents
        </Link>
        <h1 className={`text-[24px] leading-[1.25] ${IMPACT_TITLE[shown.impact]}`}>
          {shown.title}
        </h1>
        <p className="text-[16px]">
          {STATUS_LABELS[shown.status]}. {IMPACT_LABELS[shown.impact]}. Started{" "}
          <Time iso={shown.startedAt} />
          {shown.resolvedAt && (
            <>
              , resolved <Time iso={shown.resolvedAt} />
            </>
          )}
          .
        </p>
        {shown.visibility !== "draft" && (
          <VisibilityNote visibility={shown.visibility} approvalDeadline={null} />
        )}
        {shown.components.length > 0 && (
          <ul aria-label="Affected components" className="flex flex-wrap gap-x-4 gap-y-2">
            {shown.components.map((c) => (
              <li key={c.componentId} className="flex items-center gap-2">
                {nameOf(c.componentId)} <StatusLabel status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <IncidentEvidence incident={shown} />
        <IncidentPanel incident={shown} components={all} nameOf={nameOf} />
      </div>
    </div>
  );
}

/** Why it opened, each region's minutes, response time around the start, and the timeline. */
function IncidentEvidence({ incident }: { incident: IncidentDetail }) {
  const evidence = useQuery({
    queryKey: ["incidents", incident.id, "evidence"],
    queryFn: () =>
      unwrap(api.GET("/v1/incidents/{id}/evidence", { params: { path: { id: incident.id } } })),
    // Up to a few hundred results a read: asked again only when the incident changes.
    refetchOnWindowFocus: false,
  });
  if (evidence.isPending) return <Loading label="Loading what happened" />;
  if (evidence.error) return <p className="font-semibold">{evidence.error.message}</p>;
  const { monitor } = evidence.data;
  const rows = regionRows(evidence.data);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Section id="why" title="Why it opened">
        <p className="max-w-[72ch] text-[16px]">{triggerOf(incident, evidence.data)}</p>
      </Section>
      {monitor && rows.length > 0 && (
        <Section id="regions" title="Regions">
          <RegionGrid
            rows={rows}
            window={monitor.window}
            isResolved={incident.resolvedAt !== null}
          />
        </Section>
      )}
      {monitor && monitor.type !== "heartbeat" && monitor.results.length > 0 && (
        <Section id="latency" title="Response time">
          <LatencyCharts monitor={monitor} startedAt={incident.startedAt} />
        </Section>
      )}
      <Section id="timeline" title="Timeline">
        <Timeline entries={timelineOf(incident, evidence.data)} startedAt={incident.startedAt} />
      </Section>
    </div>
  );
}
