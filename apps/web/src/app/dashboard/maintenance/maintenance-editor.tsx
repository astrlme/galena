"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";
import { MaintenanceForm, type Window, type WindowInput } from "./maintenance-form.tsx";

const STATUS: Record<Window["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  verifying: "Verifying",
  completed: "Completed",
};
const small = "px-2 py-1 text-[14px]";

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
  const run = (call: () => Promise<unknown>) =>
    new Promise<boolean>((resolve) =>
      change.mutate(call, { onSuccess: () => resolve(true), onError: () => resolve(false) }),
    );

  if (windows.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading maintenance</p>;
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
    const saved = await run(() =>
      editing
        ? unwrap(
            api.PUT("/v1/maintenances/{id}", { params: { path: { id: editing.id } }, body: input }),
          )
        : unwrap(api.POST("/v1/maintenances", { body: input })),
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
        <p className="mt-4 rounded-xl border border-mist bg-surface p-4 text-[14px] text-slate">
          {empty}
        </p>
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
                <div className="ml-auto flex gap-2">
                  <Button className={small} onClick={() => setEditing(w)}>
                    Edit<span className="sr-only"> {w.title}</span>
                  </Button>
                  {w.status === "scheduled" && (
                    <Button className={small} onClick={() => setCancelling(w)}>
                      Cancel<span className="sr-only"> {w.title}</span>
                    </Button>
                  )}
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
            void run(() => unwrap(api.POST("/v1/maintenances/{id}/cancel", { params })));
            setCancelling(undefined);
          }}
          onClose={() => setCancelling(undefined)}
        />
      )}
    </>
  );
}
