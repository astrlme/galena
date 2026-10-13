"use client";

import { integrationInput, labels, type PublishPolicy, route } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { useDraft, useReopenDraft } from "../../../components/drafts.tsx";
import { control, Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
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
const HOW_TO_SEND: Record<Integration["source"], string> = {
  alertmanager:
    "Add it as a webhook receiver's url in Alertmanager, with send_resolved: true and max_alerts: 100.",
  generic: "POST alerts to it as JSON: { key, status, startsAt }, with optional title and labels.",
};
const small = "px-2 py-1 text-[14px]";
const card = "mt-4 rounded-xl border border-mist bg-surface";
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

/** "service=api, severity=critical": how a route's labels are typed. */
const labelsText = z
  .string()
  .transform((text, ctx) => {
    const entries: [string, string][] = [];
    for (const pair of text.split(",").map((p) => p.trim())) {
      if (pair === "") continue;
      const at = pair.indexOf("=");
      if (at < 1) {
        ctx.addIssue({
          code: "custom",
          message: "Write labels as name=value, separated by commas, like service=api.",
        });
        return z.NEVER;
      }
      entries.push([pair.slice(0, at).trim(), pair.slice(at + 1).trim()]);
    }
    return Object.fromEntries(entries);
  })
  .pipe(labels);
const toText = (match: Record<string, string>) =>
  Object.entries(match)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
const formSchema = integrationInput.extend({
  routes: z.array(route.extend({ match: labelsText })).max(50),
});
type FormIn = z.input<typeof formSchema>;
type FormOut = z.output<typeof formSchema>;

const EMPTY: FormIn = { source: "alertmanager", name: "", publishPolicy: "approve", routes: [] };
const NEW_ROUTE = { match: "", componentIds: [], downStatus: "major_outage" } as const;
const toInput = (i: Integration): FormIn => ({
  source: i.source,
  name: i.name,
  publishPolicy: i.publishPolicy,
  routes: i.routes.map((r) => ({ ...r, match: toText(r.match) })),
});

export function IntegrationsEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Integration>();
  const [shown, setShown] = useState<{
    name: string;
    source: Integration["source"];
    url: string;
  }>();
  const closeForm = () => {
    setAdding(false);
    setEditing(undefined);
  };
  const integrations = useQuery({
    queryKey: ["integrations"],
    queryFn: () => unwrap(api.GET("/v1/integrations")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  useReopenDraft("integration", integrations.isSuccess && components.isSuccess, (id) => {
    setProblem(undefined);
    if (id === "new") setAdding(true);
    const integration = integrations.data?.find((i) => i.id === id);
    if (integration) setEditing(integration);
    return id === "new" || integration !== undefined;
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (error) => setProblem(error.message),
  });
  /** Whether the call succeeded; a failure shows in the open form, or above the list. */
  const run = (call: () => Promise<unknown>) =>
    new Promise<boolean>((resolve) =>
      change.mutate(call, { onSuccess: () => resolve(true), onError: () => resolve(false) }),
    );

  if (integrations.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading integrations</p>;
  }
  const failed = integrations.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const named = (ids: string[]) =>
    ids.map((id) => all.find((c) => c.id === id)?.name ?? "A deleted component").join(", ");

  const save = async ({ source, ...body }: FormOut) => {
    const target = editing;
    return run(async () => {
      if (target) {
        await unwrap(
          api.PUT("/v1/integrations/{id}", { params: { path: { id: target.id } }, body }),
        );
        closeForm();
        return;
      }
      const created = await unwrap(api.POST("/v1/integrations", { body: { source, ...body } }));
      setShown({ name: body.name, source, url: created.url });
    });
  };
  const formOpen = (adding && !shown) || editing !== undefined;
  const title = editing ? `Edit ${editing.name}` : "Add an integration";

  return (
    <>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {formOpen ? undefined : problem}
      </p>
      <section aria-labelledby="integration-list" className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <h2 id="integration-list" className="text-[19px] font-semibold leading-[1.35]">
            Alert sources
          </h2>
          <Button
            variant="primary"
            onClick={() => {
              setProblem(undefined);
              setShown(undefined);
              setAdding(true);
            }}
          >
            Add integration
          </Button>
        </div>
        {integrations.data?.length === 0 ? (
          <p className={`${card} p-4 text-[14px] text-slate`}>
            None yet. Add one, then point Alertmanager, or anything that can send JSON, at its hook
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
                <div className="ml-auto flex gap-2">
                  <Button
                    className={small}
                    onClick={() => {
                      setProblem(undefined);
                      setEditing(i);
                    }}
                  >
                    Edit<span className="sr-only"> {i.name}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal.Root open={formOpen} onClose={closeForm}>
        <Modal.Title>{title}</Modal.Title>
        <IntegrationForm
          key={editing?.id ?? "new"}
          title={title}
          editing={editing}
          components={all}
          problem={formOpen ? problem : undefined}
          onSave={save}
          onCancel={closeForm}
        />
      </Modal.Root>

      <Modal.Root
        kind="dialog"
        open={shown !== undefined}
        onClose={() => {
          setShown(undefined);
          setAdding(false);
        }}
        // A URL that isn't shown again closes only on Done.
        closeOnOverlayClick={false}
        closeOnEsc={false}
      >
        {shown && (
          <>
            <Modal.Title>Hook URL for {shown.name}</Modal.Title>
            <div role="status" className="mt-4 flex flex-col gap-2">
              <p className="sr-only">Hook URL for {shown.name}</p>
              <p className="break-all rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]">
                {shown.url}
              </p>
              <p className="text-[14px] text-slate">
                Copy it now: it isn't shown again. {HOW_TO_SEND[shown.source]}
              </p>
            </div>
            <div className="mt-6">
              <Button
                variant="primary"
                onClick={() => {
                  setShown(undefined);
                  setAdding(false);
                }}
              >
                Done
              </Button>
            </div>
          </>
        )}
      </Modal.Root>
    </>
  );
}

function IntegrationForm({
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
          <div key={field.id} className="flex flex-col gap-3 rounded-[6px] border border-mist p-3">
            <Field
              id={`route-${index}-labels`}
              label={`Route ${index + 1} labels`}
              help="Like service=api, severity=critical."
              error={errors.routes?.[index]?.match?.message}
              {...form.register(`routes.${index}.match`)}
            />
            <fieldset className="flex flex-col gap-2">
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
                <p className="text-[14px] font-semibold text-major">
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
          </div>
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
