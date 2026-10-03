"use client";

import { maintenanceInput } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { useDraft } from "../../../components/drafts.tsx";
import { Field } from "../../../components/field.tsx";
import type { paths } from "../../../lib/api-schema.ts";
import { MessageField } from "../incidents/message-field.tsx";

export type Window =
  paths["/v1/maintenances"]["get"]["responses"][200]["content"]["application/json"]["maintenances"][number];

// Times are entered and shown in UTC: a datetime-local value is read as UTC, never local time.
const minute = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time.");
const schema = z
  .object({
    title: z.string(),
    body: z.string(),
    startsAt: minute.transform((v) => `${v}:00.000Z`),
    endsAt: minute.transform((v) => `${v}:00.000Z`),
    componentIds: z.array(z.string()).default([]),
  })
  .pipe(maintenanceInput);
type FormIn = z.input<typeof schema>;
export type WindowInput = Omit<z.output<typeof schema>, "componentIds"> & {
  componentIds: string[];
};

const toMinute = (iso: string) => iso.slice(0, 16);

export function MaintenanceForm({
  title,
  editing,
  components,
  problem,
  onSave,
  onCancel,
}: {
  title: string;
  editing: Window | undefined;
  components: { id: string; name: string }[];
  problem: string | undefined;
  onSave: (input: WindowInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<FormIn, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: editing
      ? {
          title: editing.title,
          body: editing.body,
          startsAt: toMinute(editing.startsAt),
          endsAt: toMinute(editing.endsAt),
          componentIds: editing.componentIds,
        }
      : { title: "", body: "", startsAt: "", endsAt: "", componentIds: [] },
  });
  const { errors, isSubmitting } = form.formState;
  const draft = useDraft(editing ? `maintenance:${editing.id}` : "maintenance:new", title, form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onSave(values))) return;
    draft.discard();
    if (!editing) form.reset();
  });
  const selected = form.watch("componentIds") ?? [];
  const toggle = (id: string, on: boolean) =>
    form.setValue("componentIds", on ? [...selected, id] : selected.filter((c) => c !== id), {
      shouldDirty: true,
    });
  const label = editing
    ? isSubmitting
      ? "Saving…"
      : "Save window"
    : isSubmitting
      ? "Scheduling…"
      : "Schedule window";

  return (
    <form onSubmit={submit} aria-label={title} className="mt-6 flex flex-col gap-4" noValidate>
      <Field
        id="window-title"
        label="Title"
        help="What people see, e.g. Database upgrade."
        error={errors.title?.message}
        {...form.register("title")}
      />
      <div className="flex flex-wrap gap-4">
        <Field
          id="window-starts"
          label="Starts (UTC)"
          type="datetime-local"
          error={errors.startsAt?.message}
          {...form.register("startsAt")}
        />
        <Field
          id="window-ends"
          label="Ends (UTC)"
          type="datetime-local"
          error={errors.endsAt?.message}
          {...form.register("endsAt")}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[14px] font-semibold">Components under maintenance</legend>
        {components.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-ink"
              checked={selected.includes(c.id)}
              onChange={(e) => toggle(c.id, e.target.checked)}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <MessageField
        id="window-body"
        error={errors.body?.message}
        registration={form.register("body")}
      />
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {label}
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
