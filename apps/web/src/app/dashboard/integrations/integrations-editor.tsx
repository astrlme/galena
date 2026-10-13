"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useReopenDraft } from "../../../components/drafts.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import { Time } from "../incidents/incident-ui.tsx";
import {
  code,
  type FormOut,
  type Integration,
  IntegrationForm,
  POLICIES,
  SOURCE,
  toText,
} from "./integration-form.tsx";

const OUTCOME: Record<NonNullable<Integration["lastOutcome"]>, string> = {
  opened: "Opened an incident",
  attached: "An open incident already covered it",
  repeat: "A repeat; nothing changed",
  resolved: "Resolved its incident",
  no_incident: "Resolved; it had no open incident",
  no_route: "No route matched its labels",
  suppressed: "Opened nothing because a component was in maintenance",
  internal_only: "Internal only; nothing opened",
};
const HOW_TO_SEND: Record<Integration["source"], ReactNode> = {
  alertmanager: (
    <>
      Add it to a webhook receiver in Alertmanager through {code("url_file")}, which keeps it out of
      the configuration, with {code("send_resolved: true")} and {code("max_alerts: 100")}.
    </>
  ),
  generic: (
    <>
      Send alerts to it as JSON: {code("{ key, status, startsAt }")}, with an optional title and
      labels.
    </>
  ),
};
const small = "px-2 py-1 text-[14px]";
const card = "mt-4 rounded-xl border border-mist bg-surface";
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

export function IntegrationsEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Integration>();
  const [renewing, setRenewing] = useState<Integration>();
  const [deleting, setDeleting] = useState<Integration>();
  const [making, setMaking] = useState(false);
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
        {formOpen || renewing ? undefined : problem}
      </p>
      <section aria-labelledby="integration-list" className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <h2 id="integration-list" className="text-[19px] font-semibold leading-[1.35]">
            All integrations
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
                      : i.routes.map((r, n) => (
                          // A route has no id of its own; two identical routes would be pointless.
                          <span key={JSON.stringify(r)}>
                            {n > 0 && "; "}
                            {toText(r.match) ? code(toText(r.match)) : "Any alert"}:{" "}
                            {named(r.componentIds)}
                          </span>
                        ))}
                    {i.routes.length > 0 && "."}
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
                  <Button
                    className={small}
                    onClick={() => {
                      setProblem(undefined);
                      setRenewing(i);
                    }}
                  >
                    Make new URL<span className="sr-only"> for {i.name}</span>
                  </Button>
                  <Button className={small} onClick={() => setDeleting(i)}>
                    Delete<span className="sr-only"> {i.name}</span>
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
        open={renewing !== undefined}
        onClose={() => setRenewing(undefined)}
      >
        {renewing && (
          <>
            <Modal.Title>Make a new URL for {renewing.name}?</Modal.Title>
            <Modal.Description>
              The current URL stops working at once. Alerts sent to it are dropped until your source
              uses the new one.
            </Modal.Description>
            <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
              {problem}
            </p>
            <div className="mt-6 flex gap-4">
              <Button
                variant="primary"
                disabled={making}
                onClick={async () => {
                  const target = renewing;
                  setMaking(true);
                  const made = await run(async () => {
                    const { url } = await unwrap(
                      api.POST("/v1/integrations/{id}/url", {
                        params: { path: { id: target.id } },
                      }),
                    );
                    setShown({ name: target.name, source: target.source, url });
                  });
                  setMaking(false);
                  if (made) setRenewing(undefined);
                }}
              >
                {making ? "Making new URL…" : "Make new URL"}
              </Button>
              <Button variant="quiet" onClick={() => setRenewing(undefined)}>
                Cancel
              </Button>
            </div>
          </>
        )}
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

      {deleting && (
        <ConfirmDelete
          kind="integration"
          name={deleting.name}
          consequence="Its hook URL stops working at once. Incidents it opened stay as they are."
          onConfirm={() => {
            const params = { path: { id: deleting.id } };
            void run(() => unwrap(api.DELETE("/v1/integrations/{id}", { params })));
            setDeleting(undefined);
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}
