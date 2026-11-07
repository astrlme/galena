"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useReopenDraft } from "../../../components/drafts.tsx";
import { Modal } from "../../../components/modal.tsx";
import { runWith } from "../../../components/run.ts";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { Loading } from "../../../components/ui/loading.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { PingUrlDialog, type ShownUrl } from "./heartbeat.tsx";
import { asBody, type FormOut, type Monitor, MonitorForm } from "./monitor-form.tsx";
import { MonitorsTable } from "./monitors-table.tsx";
import { PausedNotice, useTelemetry } from "./telemetry.tsx";

export function MonitorsEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Monitor>();
  const [deleting, setDeleting] = useState<Monitor>();
  const [pingUrl, setPingUrl] = useState<ShownUrl>();
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
    return <Loading label="Loading monitors" table />;
  }
  if (monitors.isError) return <p className="mt-8 font-semibold">{monitors.error.message}</p>;
  if (components.isError) return <p className="mt-8 font-semibold">{components.error.message}</p>;

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
          : unwrap(api.POST("/v1/monitors", { body: asBody(body) })).then((created) => {
              if (created.pingUrl) setPingUrl({ name: created.name, url: created.pingUrl });
            }),
      editing ? "Monitor saved" : "Monitor added",
    );
    if (saved) closeForm();
    return saved;
  };
  // One monitor from its row menu, or the selected ones: the toast names how many.
  const setEnabled = (ids: string[], enabled: boolean) =>
    run(
      () => unwrap(api.PATCH("/v1/monitors", { body: { ids, enabled } })),
      `${ids.length === 1 ? "Monitor" : `${ids.length} monitors`} ${enabled ? "resumed" : "paused"}`,
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
          components={components.data.components}
          problem={formOpen ? problem : undefined}
          onSave={save}
          onCancel={closeForm}
        />
      </Modal.Root>
      <PingUrlDialog shown={pingUrl} onDone={() => setPingUrl(undefined)} />
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
          <MonitorsTable
            monitors={monitors.data.monitors}
            telemetry={telemetry.data}
            onEdit={(monitor) => {
              setProblem(undefined);
              setEditing(monitor);
            }}
            onDelete={setDeleting}
            onSetEnabled={setEnabled}
          />
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
