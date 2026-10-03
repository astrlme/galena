"use client";

import { monitorInput, type PublishPolicy } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useDraft, useReopenDraft } from "../../../components/drafts.tsx";
import { control, Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { MonitorHealth, useTelemetry } from "./monitor-health.tsx";

type Monitor =
  paths["/v1/monitors"]["get"]["responses"][200]["content"]["application/json"]["monitors"][number];
type Component =
  paths["/v1/components"]["get"]["responses"][200]["content"]["application/json"]["components"][number];
type FormIn = z.input<typeof monitorInput>;
type FormOut = z.output<typeof monitorInput>;
type Body = paths["/v1/monitors"]["post"]["requestBody"]["content"]["application/json"];

/** Zod types optional fields as `T | undefined`; JSON drops undefined, so the shapes match. */
const asBody = (input: FormIn) => input as Body;

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
    help: "Drafts stay in the dashboard. Nothing reaches the status page or subscribers.",
  },
];
const policyLabel = (value: PublishPolicy) => POLICIES.find((p) => p.value === value)?.label;

const EMPTY: FormIn = {
  name: "",
  componentId: null,
  http: { url: "", method: "GET" },
  publishPolicy: "approve",
  downStatus: "major_outage",
  enabled: true,
};
const small = "px-2 py-1 text-[14px]";
const select = control;

/** A full PUT body from a listed monitor: PUT replaces every setting. */
const toInput = ({ id: _, ...input }: Monitor): FormIn => input;

export function MonitorsEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Monitor>();
  const [deleting, setDeleting] = useState<Monitor>();
  const closeForm = () => {
    setAdding(false);
    setEditing(undefined);
  };
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => unwrap(api.GET("/v1/monitors")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  const telemetry = useTelemetry();
  useReopenDraft("monitor", monitors.isSuccess, (id) => {
    setProblem(undefined);
    if (id === "new") setAdding(true);
    const monitor = monitors.data?.monitors.find((m) => m.id === id);
    if (monitor) setEditing(monitor);
    return id === "new" || monitor !== undefined;
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({ queryKey: ["monitors"] });
    },
    onError: (error) => setProblem(error.message),
  });
  /** Whether the call succeeded; a failure shows in the open form, or above the list. */
  const run = (call: () => Promise<unknown>) =>
    new Promise<boolean>((resolve) =>
      change.mutate(call, { onSuccess: () => resolve(true), onError: () => resolve(false) }),
    );

  if (monitors.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading monitors</p>;
  }
  if (monitors.isError) return <p className="mt-8 font-semibold">{monitors.error.message}</p>;
  if (components.isError) return <p className="mt-8 font-semibold">{components.error.message}</p>;
  const componentList = components.data.components;
  const componentName = (id: string | null) =>
    componentList.find((c) => c.id === id)?.name ?? "No component";

  const save = async (body: FormOut) => {
    const saved = await run(() =>
      editing
        ? unwrap(
            api.PUT("/v1/monitors/{id}", {
              params: { path: { id: editing.id } },
              body: asBody(body),
            }),
          )
        : unwrap(api.POST("/v1/monitors", { body: asBody(body) })),
    );
    if (saved) closeForm();
    return saved;
  };
  const toggle = (monitor: Monitor) =>
    run(() =>
      unwrap(
        api.PUT("/v1/monitors/{id}", {
          params: { path: { id: monitor.id } },
          body: asBody({ ...toInput(monitor), enabled: !monitor.enabled }),
        }),
      ),
    );

  const formOpen = adding || editing !== undefined;
  const title = editing ? `Edit ${editing.name}` : "Add a monitor";

  return (
    <>
      <Modal.Root open={formOpen} onClose={closeForm}>
        <Modal.Title>{title}</Modal.Title>
        <MonitorForm
          key={editing?.id ?? "new"}
          title={title}
          editing={editing}
          components={componentList}
          problem={formOpen ? problem : undefined}
          onSave={save}
          onCancel={closeForm}
        />
      </Modal.Root>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {formOpen ? undefined : problem}
      </p>

      <section aria-labelledby="monitor-list" className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <h2 id="monitor-list" className="text-[19px] font-semibold leading-[1.35]">
            All monitors
          </h2>
          <Button
            variant="primary"
            onClick={() => {
              setProblem(undefined);
              setAdding(true);
            }}
          >
            Add monitor
          </Button>
        </div>
        {telemetry.isError && (
          <p className="py-3 text-[14px]">
            Check results aren't available. {telemetry.error.message}
          </p>
        )}
        {monitors.data.monitors.length === 0 ? (
          <p className="mt-4 rounded-xl border border-mist bg-surface p-4 text-[14px] text-slate">
            No monitors yet. Add one to start checking every minute.
          </p>
        ) : (
          <ul className="mt-4 rounded-xl border border-mist bg-surface">
            {monitors.data.monitors.map((monitor) => (
              <li
                key={monitor.id}
                className="flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-semibold">{monitor.name}</span>
                  <span className="break-all text-[14px] text-slate">{monitor.http.url}</span>
                  <span className="text-[14px] text-slate">
                    {componentName(monitor.componentId)}. {policyLabel(monitor.publishPolicy)}.
                    {monitor.enabled ? "" : " Paused."}
                  </span>
                </div>
                <div className="ml-auto flex gap-2">
                  <Button className={small} onClick={() => setEditing(monitor)}>
                    Edit<span className="sr-only"> {monitor.name}</span>
                  </Button>
                  <Button className={small} onClick={() => toggle(monitor)}>
                    {monitor.enabled ? "Pause" : "Resume"}
                    <span className="sr-only"> {monitor.name}</span>
                  </Button>
                  <Button className={small} onClick={() => setDeleting(monitor)}>
                    Delete<span className="sr-only"> {monitor.name}</span>
                  </Button>
                </div>
                {telemetry.data && (
                  <MonitorHealth
                    reading={telemetry.data.monitors.find((m) => m.id === monitor.id)}
                    regions={telemetry.data.regions}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDelete
          kind="monitor"
          name={deleting.name}
          consequence={`Probes stop checking ${deleting.name} within a minute. Its check history goes with it.`}
          onConfirm={() => {
            const params = { path: { id: deleting.id } };
            void run(() => unwrap(api.DELETE("/v1/monitors/{id}", { params }))); // errors show above
            setDeleting(undefined);
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}

function MonitorForm({
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
  const draft = useDraft(
    editing ? `monitor:${editing.id}` : "monitor:new",
    editing ? title : "New monitor",
    form,
  );
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
      <div className="flex flex-col gap-1">
        <label htmlFor="monitor-method" className="text-[14px] font-semibold">
          Method
        </label>
        <select id="monitor-method" className={select} {...form.register("http.method")}>
          <option value="GET">GET</option>
          <option value="HEAD">HEAD (no body, so no keyword)</option>
        </select>
      </div>
      <Field
        id="monitor-keyword"
        label="Keyword (optional)"
        help="The check fails when the response doesn't contain this text."
        error={errors.http?.keyword?.message}
        {...form.register("http.keyword", {
          setValueAs: (v: string | undefined) => (v?.trim() ? v : undefined),
        })}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="monitor-component" className="text-[14px] font-semibold">
          Component
        </label>
        <select
          id="monitor-component"
          className={select}
          {...form.register("componentId", { setValueAs: (v: string) => (v === "" ? null : v) })}
        >
          <option value="">No component</option>
          {components.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="monitor-down-status" className="text-[14px] font-semibold">
          Status while down
        </label>
        <select id="monitor-down-status" className={select} {...form.register("downStatus")}>
          <option value="major_outage">Major outage</option>
          <option value="partial_outage">Partial outage</option>
        </select>
      </div>
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
