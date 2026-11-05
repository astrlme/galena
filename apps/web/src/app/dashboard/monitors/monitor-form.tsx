"use client";

import { monitorInput, type PublishPolicy } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { useDraft } from "../../../components/drafts.tsx";
import { Field } from "../../../components/field.tsx";
import { DOWN_STATUS_OPTIONS } from "../../../components/status.tsx";
import { FormSelect } from "../../../components/ui/select.tsx";
import type { paths } from "../../../lib/api-schema.ts";

export type Monitor =
  paths["/v1/monitors"]["get"]["responses"][200]["content"]["application/json"]["monitors"][number];
export type Component =
  paths["/v1/components"]["get"]["responses"][200]["content"]["application/json"]["components"][number];
type FormIn = z.input<typeof monitorInput>;
export type FormOut = z.output<typeof monitorInput>;
type Body = paths["/v1/monitors"]["post"]["requestBody"]["content"]["application/json"];

/** Zod types optional fields as `T | undefined`; JSON drops undefined, so the shapes match. */
export const asBody = (input: FormIn) => input as Body;

// The `approve` choice states its deadline in words.
const POLICIES: { value: PublishPolicy; label: string; help: string }[] = [
  {
    value: "approve",
    label: "Ask a person first",
    help: "Drafts wait 10 minutes for a person, then publish if the monitor is still down.",
  },
  {
    value: "auto",
    label: "Publish automatically",
    help: "Drafts publish on the status page as soon as the monitor is down.",
  },
  {
    value: "internal_only",
    label: "Internal only",
    help: "Shows in the dashboard and on the internal page only: the public status page, its history and subscribers never hear of it.",
  },
];

/** How a monitor's incidents publish, in the form's words. */
export const policyLabel = (value: PublishPolicy) => POLICIES.find((p) => p.value === value)?.label;

const EMPTY: FormIn = {
  name: "",
  componentId: null,
  http: { url: "", method: "GET" },
  publishPolicy: "approve",
  downStatus: "major_outage",
  enabled: true,
};

/** A full PUT body from a listed monitor: PUT replaces every setting. */
const toInput = ({ id: _, ...input }: Monitor): FormIn => input;

export function MonitorForm({
  title,
  editing,
  components,
  problem,
  onSave,
  onCancel,
}: {
  title: string;
  editing: Monitor | undefined;
  components: Component[];
  problem: string | undefined;
  onSave: (body: FormOut) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(monitorInput),
    defaultValues: editing ? toInput(editing) : EMPTY,
  });
  const { errors, isSubmitting } = form.formState;
  const draft = useDraft(editing ? `monitor:${editing.id}` : "monitor:new", title, form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onSave(values))) return;
    draft.discard();
    form.reset(EMPTY);
  });
  return (
    <form onSubmit={submit} aria-label={title} className="mt-6 flex flex-col gap-4" noValidate>
      <Field
        id="monitor-name"
        label="Monitor name"
        help="What your team calls it, e.g. API health."
        error={errors.name?.message}
        {...form.register("name")}
      />
      <Field
        id="monitor-url"
        label="URL"
        type="url"
        help="The public address to check, e.g. https://api.example.com/health."
        error={errors.http?.url?.message}
        {...form.register("http.url")}
      />
      <FormSelect
        control={form.control}
        name="http.method"
        label="Method"
        options={[
          { value: "GET", label: "GET" },
          { value: "HEAD", label: "HEAD (no body, so no keyword)" },
        ]}
      />
      <Field
        id="monitor-keyword"
        label="Keyword (optional)"
        help="The check fails when the response doesn't contain this text."
        error={errors.http?.keyword?.message}
        {...form.register("http.keyword", {
          setValueAs: (v: string | undefined) => (v?.trim() ? v : undefined),
        })}
      />
      <FormSelect
        control={form.control}
        name="componentId"
        label="Component"
        options={[
          { value: null, label: "No component" },
          ...components.map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <FormSelect
        control={form.control}
        name="downStatus"
        label="Status while down"
        options={DOWN_STATUS_OPTIONS}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[14px] font-semibold">When it goes down</legend>
        {POLICIES.map((policy) => (
          <label key={policy.value} className="flex gap-3">
            <input
              type="radio"
              value={policy.value}
              className="mt-1 accent-ink"
              {...form.register("publishPolicy")}
            />
            <span className="flex flex-col">
              <span className="font-semibold">{policy.label}</span>
              <span className="text-[14px] text-slate">{policy.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {editing
            ? isSubmitting
              ? "Saving…"
              : "Save monitor"
            : isSubmitting
              ? "Adding…"
              : "Add monitor"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            draft.discard();
            onCancel();
          }}
        >
          {draft.dirty ? "Discard" : "Cancel"}
        </Button>
      </div>
    </form>
  );
}
