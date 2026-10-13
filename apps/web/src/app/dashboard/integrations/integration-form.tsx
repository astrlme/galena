"use client";

import {
  integrationInput,
  labels,
  MAX_LABEL_NAME,
  MAX_LABEL_VALUE,
  MAX_LABELS,
  type PublishPolicy,
  route,
} from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { useDraft } from "../../../components/drafts.tsx";
import { control, Field } from "../../../components/field.tsx";
import type { paths } from "../../../lib/api-schema.ts";

export type Integration =
  paths["/v1/integrations"]["get"]["responses"][200]["content"]["application/json"][number];

export const SOURCE: Record<Integration["source"], string> = {
  alertmanager: "Alertmanager",
  generic: "Generic JSON",
};
export const POLICIES: { value: PublishPolicy; label: string; help: string }[] = [
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
export const code = (text: string) => <code className="font-mono">{text}</code>;
const small = "px-2 py-1 text-[14px]";

/** "service=api, severity=critical": how a route's labels are typed. */
const labelsText = z
  .string()
  .transform((text, ctx) => {
    const entries: [string, string][] = [];
    const refuse = (message: string) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    for (const pair of text.split(",").map((p) => p.trim())) {
      if (pair === "") continue;
      const at = pair.indexOf("=");
      if (at < 1)
        return refuse("Write labels as name=value, separated by commas, like service=api.");
      const [name, value] = [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
      if (name.length > MAX_LABEL_NAME || value.length > MAX_LABEL_VALUE) {
        return refuse("Keep label names to 100 characters and values to 1,000.");
      }
      entries.push([name, value]);
    }
    if (entries.length > MAX_LABELS) return refuse("Use at most 64 labels in a route.");
    return Object.fromEntries(entries);
  })
  .pipe(labels);
export const toText = (match: Record<string, string>) =>
  Object.entries(match)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
const formSchema = integrationInput.extend({
  routes: z.array(route.extend({ match: labelsText })).max(50),
});
type FormIn = z.input<typeof formSchema>;
export type FormOut = z.output<typeof formSchema>;

const EMPTY: FormIn = { source: "alertmanager", name: "", publishPolicy: "approve", routes: [] };
const NEW_ROUTE = { match: "", componentIds: [], downStatus: "major_outage" } as const;
const toInput = (i: Integration): FormIn => ({
  source: i.source,
  name: i.name,
  publishPolicy: i.publishPolicy,
  routes: i.routes.map((r) => ({ ...r, match: toText(r.match) })),
});

export function IntegrationForm({
  title,
  editing,
  components,
  problem,
  onSave,
  onCancel,
}: {
  title: string;
  editing: Integration | undefined;
  components: { id: string; name: string }[];
  problem: string | undefined;
  onSave: (body: FormOut) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(formSchema),
    defaultValues: editing ? toInput(editing) : EMPTY,
  });
  const { errors, isSubmitting } = form.formState;
  const routes = useFieldArray({ control: form.control, name: "routes" });
  const draft = useDraft(editing ? `integration:${editing.id}` : "integration:new", title, form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onSave(values))) return;
    draft.discard();
    form.reset(EMPTY);
  });
  const chosen = (index: number) => form.watch(`routes.${index}.componentIds`) ?? [];
  const toggle = (index: number, id: string, on: boolean) => {
    const ids = chosen(index);
    form.setValue(`routes.${index}.componentIds`, on ? [...ids, id] : ids.filter((c) => c !== id), {
      shouldDirty: true,
    });
  };

  return (
    <form onSubmit={submit} aria-label={title} className="mt-6 flex flex-col gap-4" noValidate>
      {editing ? (
        <p className="text-[14px]">
          <span className="font-semibold">Source:</span> {SOURCE[editing.source]}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor="integration-source" className="text-[14px] font-semibold">
            Source
          </label>
          <select id="integration-source" className={control} {...form.register("source")}>
            <option value="alertmanager">Alertmanager</option>
            <option value="generic">Generic JSON</option>
          </select>
        </div>
      )}
      <Field
        id="integration-name"
        label="Name"
        help="What your team calls it, like Production Prometheus."
        error={errors.name?.message}
        {...form.register("name")}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[14px] font-semibold">When an alert fires</legend>
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

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-[14px] font-semibold">Routes</legend>
        <p className="text-[14px] text-slate">
          An alert takes the first route whose labels it has, and marks that route's components.
          Leave the labels empty to catch every alert the routes above miss.
        </p>
        {routes.fields.map((field, index) => (
          <fieldset
            key={field.id}
            className="flex flex-col gap-3 rounded-[6px] border border-mist p-3"
          >
            <legend className="px-1 text-[14px] font-semibold">Route {index + 1}</legend>
            <Field
              id={`route-${index}-labels`}
              label="Labels"
              help="Like service=api, severity=critical."
              error={errors.routes?.[index]?.match?.message}
              {...form.register(`routes.${index}.match`)}
            />
            <fieldset
              className="flex flex-col gap-2"
              aria-invalid={errors.routes?.[index]?.componentIds ? true : undefined}
              aria-describedby={
                errors.routes?.[index]?.componentIds ? `route-${index}-components-note` : undefined
              }
            >
              <legend className="mb-1 text-[14px] font-semibold">Components it marks</legend>
              {components.length === 0 && (
                <p className="text-[14px] text-slate">Add components first.</p>
              )}
              {components.map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-ink"
                    checked={chosen(index).includes(c.id)}
                    onChange={(e) => toggle(index, c.id, e.target.checked)}
                  />
                  {c.name}
                </label>
              ))}
              {errors.routes?.[index]?.componentIds && (
                <p
                  id={`route-${index}-components-note`}
                  aria-live="polite"
                  className="text-[14px] font-semibold text-major"
                >
                  {errors.routes[index]?.componentIds?.message}
                </p>
              )}
            </fieldset>
            <div className="flex flex-col gap-1">
              <label htmlFor={`route-${index}-status`} className="text-[14px] font-semibold">
                Status while firing
              </label>
              <select
                id={`route-${index}-status`}
                className={control}
                {...form.register(`routes.${index}.downStatus`)}
              >
                <option value="major_outage">Major outage</option>
                <option value="partial_outage">Partial outage</option>
              </select>
            </div>
            <div>
              <Button type="button" className={small} onClick={() => routes.remove(index)}>
                Remove route {index + 1}
              </Button>
            </div>
          </fieldset>
        ))}
        <div>
          <Button type="button" onClick={() => routes.append({ ...NEW_ROUTE, componentIds: [] })}>
            Add route
          </Button>
        </div>
      </fieldset>

      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {editing
            ? isSubmitting
              ? "Saving…"
              : "Save integration"
            : isSubmitting
              ? "Adding…"
              : "Add integration"}
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
