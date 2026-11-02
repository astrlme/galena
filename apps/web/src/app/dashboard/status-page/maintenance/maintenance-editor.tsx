"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../../../components/button.tsx";
import { ConfirmDelete } from "../../../../components/confirm-delete.tsx";
import { useReopenDraft } from "../../../../components/drafts.tsx";
import { Modal } from "../../../../components/modal.tsx";
import { runWith } from "../../../../components/run.ts";
import { EmptyState } from "../../../../components/ui/empty-state.tsx";
import { Loading } from "../../../../components/ui/loading.tsx";
import { RowMenu } from "../../../../components/ui/row-menu.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import { Time } from "../../incidents/incident-ui.tsx";
import { MaintenanceForm, type Window, type WindowInput } from "./maintenance-form.tsx";

const STATUS: Record<Window["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  verifying: "Verifying",
  completed: "Completed",
};

export function MaintenanceEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Window>();
  const [cancelling, setCancelling] = useState<Window>();
  const windows = useQuery({
    queryKey: ["maintenances"],
    queryFn: () => unwrap(api.GET("/v1/maintenances")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({ queryKey: ["maintenances"] });
    },
    onError: (error) => setProblem(error.message),
  });
  useReopenDraft("maintenance", windows.isSuccess, (id) => {
    setProblem(undefined);
    if (id === "new") setAdding(true);
    const found = windows.data?.maintenances.find((w) => w.id === id && w.status !== "completed");
    if (found) setEditing(found);
    return id === "new" || found !== undefined;
  });
  const run = runWith(change);

  if (windows.isPending || components.isPending) {
    return <Loading label="Loading maintenance" />;
  }
  const failed = windows.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const list = windows.data?.maintenances ?? [];
  const nameOf = (id: string) => all.find((c) => c.id === id)?.name ?? "A deleted component";

  const closeForm = () => {
    setAdding(false);
    setEditing(undefined);
  };
  const save = async (input: WindowInput) => {
    const saved = await run(
      () =>
        editing
          ? unwrap(
              api.PUT("/v1/maintenances/{id}", {
                params: { path: { id: editing.id } },
                body: input,
              }),
            )
          : unwrap(api.POST("/v1/maintenances", { body: input })),
      editing ? "Window saved" : "Window scheduled",
    );
    if (saved) closeForm();
    return saved;
  };
  const formOpen = adding || editing !== undefined;
  const formTitle = editing ? `Edit ${editing.title}` : "Schedule a window";

  const section = (
    id: string,
    title: string,
    empty: string,
    shown: Window[],
    action?: ReactNode,
  ) => (
    <section aria-labelledby={id} className="mt-8">
      <div className="flex items-center justify-between gap-4">
        <h2 id={id} className="text-[19px] font-semibold leading-[1.35]">
          {title}
        </h2>
        {action}
      </div>
      {shown.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="mt-4 rounded-xl border border-mist bg-surface">
          {shown.map((w) => (
            <li
              key={w.id}
              className="flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">{w.title}</span>
                <span className="text-[14px]">
                  {w.cancelledAt ? "Cancelled" : STATUS[w.status]}. <Time iso={w.startsAt} /> to{" "}
                  <Time iso={w.endsAt} />.
                </span>
                {w.componentIds.length > 0 && (
                  <span className="text-[14px] text-slate">
                    {w.componentIds.map(nameOf).join(", ")}.
                  </span>
                )}
              </div>
              {w.status !== "completed" && (
                <div className="ml-auto">
                  <RowMenu
                    name={w.title}
                    actions={[
                      { label: "Edit", isEdit: true, onSelect: () => setEditing(w) },
                      ...(w.status === "scheduled"
                        ? [
                            {
                              label: "Cancel window",
                              destructive: true,
                              onSelect: () => setCancelling(w),
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {formOpen ? undefined : problem}
      </p>
      {section(
        "upcoming-windows",
        "Upcoming and running",
        "Nothing scheduled. Schedule a window before planned work.",
        list.filter((w) => w.status !== "completed"),
        <Button
          variant="primary"
          onClick={() => {
            setProblem(undefined);
            setAdding(true);
          }}
        >
          Schedule window
        </Button>,
      )}
      <Modal.Root open={formOpen} onClose={closeForm}>
        <Modal.Title>{formTitle}</Modal.Title>
        <MaintenanceForm
          key={editing?.id ?? "new"}
          title={formTitle}
          editing={editing}
          components={all}
          problem={formOpen ? problem : undefined}
          onSave={save}
          onCancel={closeForm}
        />
      </Modal.Root>
      {section(
        "past-windows",
        "Past",
        "No past windows yet.",
        list.filter((w) => w.status === "completed"),
      )}

      {cancelling && (
        <ConfirmDelete
          kind="window"
          verb="Cancel"
          name={cancelling.title}
          consequence="The window won't start. People following the page will see it was cancelled."
          onConfirm={() => {
            const params = { path: { id: cancelling.id } };
            // Errors show above the list.
            void run(
              () => unwrap(api.POST("/v1/maintenances/{id}/cancel", { params })),
              "Window cancelled",
            );
            setCancelling(undefined);
          }}
          onClose={() => setCancelling(undefined)}
        />
      )}
    </>
  );
}
