"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useReopenDraft } from "../../../components/drafts.tsx";
import { Modal } from "../../../components/modal.tsx";
import { runWith } from "../../../components/run.ts";
import { StatusLabel } from "../../../components/status.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { Loading } from "../../../components/ui/loading.tsx";
import { RowMenu } from "../../../components/ui/row-menu.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import {
  asBody,
  type FormOut,
  type Monitor,
  MonitorForm,
  policyLabel,
  toInput,
} from "./monitor-form.tsx";
import { MonitorHealth, PausedNotice, useTelemetry } from "./monitor-health.tsx";

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
  const run = runWith(change);

  if (monitors.isPending || components.isPending) {
    return <Loading label="Loading monitors" />;
  }
  if (monitors.isError) return <p className="mt-8 font-semibold">{monitors.error.message}</p>;
  if (components.isError) return <p className="mt-8 font-semibold">{components.error.message}</p>;
  const componentList = components.data.components;
  const componentName = (id: string | null) =>
    componentList.find((c) => c.id === id)?.name ?? "No component";

  const save = async (body: FormOut) => {
    const saved = await run(
      () =>
        editing
          ? unwrap(
              api.PUT("/v1/monitors/{id}", {
                params: { path: { id: editing.id } },
                body: asBody(body),
              }),
            )
          : unwrap(api.POST("/v1/monitors", { body: asBody(body) })),
      editing ? "Monitor saved" : "Monitor added",
    );
    if (saved) closeForm();
    return saved;
  };
  const toggle = (monitor: Monitor) =>
    run(
      () =>
        unwrap(
          api.PUT("/v1/monitors/{id}", {
            params: { path: { id: monitor.id } },
            body: asBody({ ...toInput(monitor), enabled: !monitor.enabled }),
          }),
        ),
      monitor.enabled ? "Monitor paused" : "Monitor resumed",
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
        <PausedNotice paused={telemetry.paused} />
        {monitors.data.monitors.length === 0 ? (
          <EmptyState>No monitors yet. Add one to start checking every minute.</EmptyState>
        ) : (
          <ul className="mt-4 rounded-xl border border-mist bg-surface">
            {monitors.data.monitors.map((monitor) => (
              <li
                key={monitor.id}
                className="flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-semibold">{monitor.name}</span>
                    {monitor.enabled && telemetry.data && (
                      <StatusLabel
                        status={
                          telemetry.data.monitors.find((m) => m.id === monitor.id)?.status ?? null
                        }
                      />
                    )}
                  </div>
                  <span className="break-all text-[14px] text-slate">{monitor.http.url}</span>
                  <span className="text-[14px] text-slate">
                    {componentName(monitor.componentId)}. {policyLabel(monitor.publishPolicy)}.
                    {monitor.enabled ? "" : " Paused."}
                  </span>
                </div>
                <div className="ml-auto">
                  <RowMenu
                    name={monitor.name}
                    actions={[
                      { label: "Edit", isEdit: true, onSelect: () => setEditing(monitor) },
                      {
                        label: monitor.enabled ? "Pause" : "Resume",
                        onSelect: () => void toggle(monitor),
                      },
                      { label: "Delete", destructive: true, onSelect: () => setDeleting(monitor) },
                    ]}
                  />
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
            void run(() => unwrap(api.DELETE("/v1/monitors/{id}", { params })), "Monitor deleted"); // errors show above
            setDeleting(undefined);
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}
