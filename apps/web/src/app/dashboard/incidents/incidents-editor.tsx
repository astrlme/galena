"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { useReopenDraft } from "../../../components/drafts.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { IncidentForm, type NewIncident } from "./incident-form.tsx";
import { IMPACT_LABELS, IMPACT_TITLE, STATUS_LABELS, Time } from "./incident-ui.tsx";

type Summary =
  paths["/v1/incidents"]["get"]["responses"][200]["content"]["application/json"]["incidents"][number];

const list = (state: "open" | "resolved") => () =>
  unwrap(api.GET("/v1/incidents", { params: { query: { state } } }));

export function IncidentsEditor() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const open = useQuery({ queryKey: ["incidents", "open"], queryFn: list("open") });
  const resolved = useQuery({ queryKey: ["incidents", "resolved"], queryFn: list("resolved") });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  useReopenDraft("incident", components.isSuccess, (id) => {
    setProblem(undefined);
    setPublishing(id === "new");
    return id === "new";
  });

  if (open.isPending || resolved.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading incidents</p>;
  }
  const failed = open.error ?? resolved.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const nameOf = (id: string) => all.find((c) => c.id === id)?.name ?? "A deleted component";

  const publish = async (incident: NewIncident) => {
    try {
      const created = await unwrap(api.POST("/v1/incidents", { body: incident }));
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
      router.push(`/dashboard/incidents/view/?id=${created.id}`);
      return true;
    } catch (error) {
      setProblem((error as Error).message);
      return false;
    }
  };

  const section = (
    id: string,
    title: string,
    empty: string,
    incidents: Summary[],
    action?: ReactNode,
  ) => (
    <section aria-labelledby={id} className="mt-8">
      <div className="flex items-center justify-between gap-4">
        <h2 id={id} className="text-[19px] font-semibold leading-[1.35]">
          {title}
        </h2>
        {action}
      </div>
      {incidents.length === 0 ? (
        <p className="mt-4 rounded-xl border border-mist bg-surface p-4 text-[14px] text-slate">
          {empty}
        </p>
      ) : (
        <ul className="mt-4 rounded-xl border border-mist bg-surface">
          {incidents.map((incident) => (
            <li key={incident.id} className="border-b border-mist px-4 py-3 last:border-b-0">
              <div className="flex flex-col gap-1">
                <Link
                  href={`/dashboard/incidents/view/?id=${incident.id}`}
                  className={`text-[16px] underline-offset-2 hover:underline ${IMPACT_TITLE[incident.impact]}`}
                >
                  {incident.title}
                </Link>
                <span className="text-[14px]">
                  {STATUS_LABELS[incident.status]}. {IMPACT_LABELS[incident.impact]}.
                  {incident.components.length > 0 &&
                    ` ${incident.components.map((c) => nameOf(c.componentId)).join(", ")}.`}
                </span>
                <span className="text-[14px] text-slate">
                  Updated <Time iso={incident.updatedAt} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      {section(
        "open-incidents",
        "Open incidents",
        "No open incidents. Publish one when something is wrong.",
        open.data?.incidents ?? [],
        <Button
          variant="primary"
          onClick={() => {
            setProblem(undefined);
            setPublishing(true);
          }}
        >
          Publish incident
        </Button>,
      )}
      <Modal.Root open={publishing} onClose={() => setPublishing(false)}>
        <Modal.Title>Publish an incident</Modal.Title>
        <IncidentForm
          components={all}
          problem={problem}
          onPublish={publish}
          onCancel={() => setPublishing(false)}
        />
      </Modal.Root>
      {section(
        "resolved-incidents",
        "Resolved",
        "Nothing resolved yet.",
        resolved.data?.incidents ?? [],
      )}
    </>
  );
}
