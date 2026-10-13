"use client";

import type { PublishPolicy } from "@galena/contracts";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { Time } from "../incidents/incident-ui.tsx";

type Integration =
  paths["/v1/integrations"]["get"]["responses"][200]["content"]["application/json"][number];

const SOURCE: Record<Integration["source"], string> = {
  alertmanager: "Alertmanager",
  generic: "Generic JSON",
};
const POLICIES: { value: PublishPolicy; label: string; help: string }[] = [
  {
    value: "approve",
    label: "Ask a person first",
    help: "Drafts wait 10 minutes for a person, then publish if the alert is still firing.",
  },
  {
    value: "auto",
    label: "Publish automatically",
    help: "Incidents publish on the status page as soon as an alert fires.",
  },
  {
    value: "internal_only",
    label: "Internal only",
    help: "Alerts open nothing: the integration only shows what it received.",
  },
];
const OUTCOME: Record<NonNullable<Integration["lastOutcome"]>, string> = {
  opened: "Opened an incident",
  attached: "An open incident already covered it",
  repeat: "A repeat; nothing changed",
  resolved: "Resolved its incident",
  no_incident: "Resolved; it had no open incident",
  no_route: "No route matched its labels",
  suppressed: "Held: a component was in maintenance",
  internal_only: "Internal only; nothing opened",
};
const card = "mt-4 rounded-xl border border-mist bg-surface";
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

const toText = (match: Record<string, string>) =>
  Object.entries(match)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");

export function IntegrationsEditor() {
  const integrations = useQuery({
    queryKey: ["integrations"],
    queryFn: () => unwrap(api.GET("/v1/integrations")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });

  if (integrations.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading integrations</p>;
  }
  const failed = integrations.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const named = (ids: string[]) =>
    ids.map((id) => all.find((c) => c.id === id)?.name ?? "A deleted component").join(", ");

  return (
    <section aria-labelledby="integration-list" className="mt-8">
      <h2 id="integration-list" className="text-[19px] font-semibold leading-[1.35]">
        Alert sources
      </h2>
      {integrations.data?.length === 0 ? (
        <p className={`${card} p-4 text-[14px] text-slate`}>
          None yet. Point Alertmanager, or anything that can send JSON, at an integration's hook
          URL.
        </p>
      ) : (
        <ul className={card}>
          {integrations.data?.map((i) => (
            <li key={i.id} className={row}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">{i.name}</span>
                <span className="text-[14px]">
                  {SOURCE[i.source]}. {POLICIES.find((p) => p.value === i.publishPolicy)?.label}.{" "}
                  {i.routes.length === 0
                    ? "No routes yet, so alerts open nothing."
                    : i.routes
                        .map((r) => `${toText(r.match) || "Any alert"}: ${named(r.componentIds)}`)
                        .join("; ")}
                </span>
                <span className="text-[14px] text-slate">
                  {i.lastSignalAt && i.lastOutcome ? (
                    <>
                      Last alert <Time iso={i.lastSignalAt} />: {OUTCOME[i.lastOutcome]}.
                    </>
                  ) : (
                    "No alerts yet."
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
