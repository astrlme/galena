"use client";

import { type IncidentImpact, incidentCreate, incidentImpacts } from "@galena/contracts";
import { checkUpdateBody } from "@galena/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { Field } from "../../../components/field.tsx";
import {
  type Affected,
  ComponentPicker,
  componentNames,
  IMPACT_LABELS,
  STATUS_LABELS,
  select,
} from "./incident-ui.tsx";
import { MessageField, useTemplate } from "./message-field.tsx";

/** The API's schema, plus the same check the API makes on the words before they are published. */
export const bodyChecked = z.string().superRefine((body, ctx) => {
  const checked = checkUpdateBody(body.trim());
  if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.error.message });
});
const schema = incidentCreate.extend({ body: incidentCreate.shape.body.pipe(bodyChecked) });
type FormIn = z.input<typeof schema>;
export type NewIncident = Omit<z.output<typeof schema>, "components"> & { components: Affected[] };

const IMPACT_HELP: Record<IncidentImpact, string> = {
  none: "Worth telling people, nothing is broken.",
  minor: "Some people see errors or slowness.",
  major: "Many people can't use part of the service.",
  critical: "The service is down for most people.",
};
const OPENING = ["investigating", "identified", "monitoring", "resolved"] as const;

export function IncidentForm({
  components,
  onPublish,
}: {
  components: { id: string; name: string }[];
  /** Resolves to whether it was published; the form keeps its values if not. */
  onPublish: (incident: NewIncident) => Promise<boolean>;
}) {
  const [affected, setAffected] = useState<Affected[]>([]);
  const form = useForm<FormIn, unknown, NewIncident>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", impact: "minor", status: "investigating", body: "" },
  });
  const { errors, isSubmitting } = form.formState;
  useTemplate(
    form.watch("status") ?? "investigating",
    componentNames(components, affected),
    form.watch("body") ?? "",
    (text) => form.setValue("body", text),
  );
  const submit = form.handleSubmit((values) => onPublish({ ...values, components: affected }));

  return (
    <form
      onSubmit={submit}
      aria-label="Publish an incident"
      className="mt-8 flex max-w-[640px] flex-col gap-4"
      noValidate
    >
      <h2 className="text-[19px] font-semibold leading-[1.35]">Publish an incident</h2>
      <Field
        id="incident-title"
        label="Title"
        help="What people see first, e.g. Elevated API errors."
        error={errors.title?.message}
        {...form.register("title")}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[14px] font-semibold">Impact</legend>
        {incidentImpacts.map((impact) => (
          <label key={impact} className="flex gap-3">
            <input
              type="radio"
              value={impact}
              className="mt-1 accent-ink"
              {...form.register("impact")}
            />
            <span className="flex flex-col">
              <span className="font-semibold">{IMPACT_LABELS[impact]}</span>
              <span className="text-[14px] text-slate">{IMPACT_HELP[impact]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ComponentPicker components={components} value={affected} onChange={setAffected} />
      <div className="flex flex-col gap-1">
        <label htmlFor="incident-status" className="text-[14px] font-semibold">
          Status
        </label>
        <select id="incident-status" className={select} {...form.register("status")}>
          {OPENING.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      <MessageField
        id="incident-body"
        error={errors.body?.message}
        registration={form.register("body")}
      />
      <div>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? "Publishing…" : "Publish incident"}
        </Button>
      </div>
    </form>
  );
}
