"use client";

import type { IncidentComponentStatus, IncidentImpact, IncidentStatus } from "@galena/contracts";
import { control } from "../../../components/field.tsx";

/** A component an incident names, as the API sends and takes it. */
export type Affected = { componentId: string; status: IncidentComponentStatus };

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
  postmortem: "Postmortem",
};

export const IMPACT_LABELS: Record<IncidentImpact, string> = {
  none: "No impact",
  minor: "Minor impact",
  major: "Major impact",
  critical: "Critical impact",
};

// A bigger impact gets a heavier title; its label says which.
export const IMPACT_TITLE: Record<IncidentImpact, string> = {
  none: "font-normal",
  minor: "font-normal",
  major: "font-semibold",
  critical: "font-[650]",
};

const COMPONENT_STATUS_LABELS: Record<IncidentComponentStatus, string> = {
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  operational: "Operational",
};

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const two = (n: number) => String(n).padStart(2, "0");

/** A UTC time, with the reader's local time on hover. */
export function Time({ iso }: { iso: string }) {
  const at = new Date(iso);
  const utc = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
  return (
    <time dateTime={iso} title={at.toLocaleString()} className="tabular-nums">
      {utc}
    </time>
  );
}

export const select = control;

/** Which components the incident affects, and the status it gives each. */
export function ComponentPicker({
  components,
  value,
  onChange,
}: {
  components: { id: string; name: string }[];
  value: Affected[];
  onChange: (next: Affected[]) => void;
}) {
  const statusOf = (id: string) => value.find((a) => a.componentId === id)?.status;
  const set = (id: string, status: IncidentComponentStatus | undefined) =>
    onChange(
      status === undefined
        ? value.filter((a) => a.componentId !== id)
        : [...value.filter((a) => a.componentId !== id), { componentId: id, status }],
    );

  if (components.length === 0) {
    return <p className="text-[14px] text-slate">No components yet. Add them under Components.</p>;
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[14px] font-semibold">Affected components</legend>
      {components.map((c) => {
        const status = statusOf(c.id);
        return (
          <div key={c.id} className="flex flex-wrap items-center gap-3">
            <label className="flex min-w-[160px] items-center gap-2">
              <input
                type="checkbox"
                className="accent-ink"
                checked={status !== undefined}
                onChange={(e) => set(c.id, e.target.checked ? "partial_outage" : undefined)}
              />
              {c.name}
            </label>
            {status !== undefined && (
              <select
                aria-label={`Status of ${c.name}`}
                className={select}
                value={status}
                onChange={(e) => set(c.id, e.target.value as IncidentComponentStatus)}
              >
                {Object.entries(COMPONENT_STATUS_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Names for the message templates: "API", "API and Web", "API, Web and Search". */
export function componentNames(components: { id: string; name: string }[], value: Affected[]) {
  const names = value.flatMap((a) => components.find((c) => c.id === a.componentId)?.name ?? []);
  if (names.length === 0) return undefined;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
