"use client";

import { type ApiKeyScope, apiKeyInput } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useDraft, useReopenDraft } from "../../../components/drafts.tsx";
import { Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { columnsFor, DataTable } from "../../../components/ui/data-table.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { Loading } from "../../../components/ui/loading.tsx";
import { RowMenu } from "../../../components/ui/row-menu.tsx";
import { FormSelect } from "../../../components/ui/select.tsx";
import { toast } from "../../../components/ui/toast.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { Time } from "../incidents/incident-ui.tsx";

const heading = "text-[19px] font-semibold leading-[1.35]";
const card = "mt-4 rounded-xl border border-mist bg-surface";

const SCOPE: Record<ApiKeyScope, string> = {
  read: "Read, like a viewer",
  write: "Write, like an editor: also creates and changes",
  admin: "Admin: also webhooks, subscribers, integrations and Slack",
};

type Key = paths["/v1/api-keys"]["get"]["responses"][200]["content"]["application/json"][number];

const keyColumn = columnsFor<Key>();
const KEY_COLUMNS = keyColumn.columns([
  keyColumn.accessor("name", {
    header: "Name",
    cell: (c) => <span className="font-semibold">{c.getValue()}</span>,
  }),
  keyColumn.accessor("scope", {
    header: "Scope",
    enableSorting: false,
    cell: (c) => SCOPE[c.getValue()],
  }),
  keyColumn.accessor("prefix", {
    header: "Starts with",
    enableSorting: false,
    cell: (c) => <span className="font-mono">{c.getValue()}</span>,
  }),
  keyColumn.accessor("createdAt", { header: "Made", cell: (c) => <Time iso={c.getValue()} /> }),
]);

/** Admins make keys for scripts here; for everyone else the section isn't shown. */
export function ApiKeys() {
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [making, setMaking] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [made, setMade] = useState<{ name: string; key: string }>();
  const [removing, setRemoving] = useState<Key>();
  const [problem, setProblem] = useState<string>();
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const { data, response } = await api.GET("/v1/api-keys");
      // Only admins manage keys.
      if (response.status === 403) return null;
      if (!data) throw new Error("Couldn't load the API keys. Reload the page to try again.");
      return data;
    },
  });
  const change = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  useReopenDraft("api-key", keys.isSuccess, (id) => {
    setProblem(undefined);
    setMade(undefined);
    setMaking(id === "new");
    return id === "new";
  });

  if (keys.data === null) return null;

  return (
    <section className="mt-8" aria-labelledby="api-keys-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="api-keys-heading" ref={headingRef} tabIndex={-1} className={heading}>
          API keys
        </h2>
        {keys.isSuccess && (
          <Button
            onClick={() => {
              setProblem(undefined);
              setNotice(undefined);
              setMaking(true);
            }}
          >
            Make API key
          </Button>
        )}
      </div>
      <p className="mt-2 max-w-[72ch] text-slate">
        For scripts that call the{" "}
        <a href="/docs/reference/api/" className="underline">
          API
        </a>
        . A key acts as the admin who made it, at most at its scope, and stops working if they leave
        the workspace.
      </p>
      {keys.isPending ? (
        <Loading label="Loading the API keys" className="mt-4" rows={2} table />
      ) : keys.error ? (
        <p className={`${card} p-4 font-semibold`}>{keys.error.message}</p>
      ) : keys.data.length === 0 ? (
        <EmptyState>
          None yet. Make one key per script, so you can delete one without stopping the others.
        </EmptyState>
      ) : (
        <DataTable
          label="API keys"
          data={keys.data}
          columns={KEY_COLUMNS}
          actions={(k) => (
            <RowMenu
              name={k.name}
              actions={[{ label: "Delete", destructive: true, onSelect: () => setRemoving(k) }]}
            />
          )}
        />
      )}
      <p role="status" className="mt-3 text-[14px] font-semibold empty:hidden">
        {making ? undefined : (problem ?? notice)}
      </p>

      <Modal.Root open={making && !made} onClose={() => setMaking(false)}>
        <Modal.Title>Make an API key</Modal.Title>
        <KeyForm
          problem={making ? problem : undefined}
          onCancel={() => setMaking(false)}
          onSave={(input) =>
            new Promise<boolean>((resolve) =>
              change.mutate(
                async () => {
                  const created = await unwrap(api.POST("/v1/api-keys", { body: input }));
                  setMade({ name: input.name, key: created.key });
                },
                { onSuccess: () => resolve(true), onError: () => resolve(false) },
              ),
            )
          }
        />
      </Modal.Root>
      <Modal.Root
        kind="dialog"
        open={made !== undefined}
        onClose={() => {
          setMade(undefined);
          setMaking(false);
        }}
        // A key that isn't shown again closes only on Done.
        closeOnOverlayClick={false}
        closeOnEsc={false}
      >
        {made && (
          <>
            <Modal.Title>API key for {made.name}</Modal.Title>
            <div role="status" className="mt-4 flex flex-col gap-2">
              <p className="sr-only">API key for {made.name}</p>
              <p className="break-all rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]">
                {made.key}
              </p>
              <p className="text-[14px] text-slate">
                Copy it now: it isn't shown again. Scripts send it in the{" "}
                <span className="font-mono">Authorization</span> header, after{" "}
                <span className="font-mono">Bearer</span>.
              </p>
            </div>
            <div className="mt-6">
              <Button
                variant="primary"
                onClick={() => {
                  setMade(undefined);
                  setMaking(false);
                }}
              >
                Done
              </Button>
            </div>
          </>
        )}
      </Modal.Root>
      {removing && (
        <ConfirmDelete
          kind="API key"
          name={removing.name}
          consequence="Scripts using it are refused from their next request."
          onConfirm={() => {
            const params = { path: { id: removing.id } };
            change.mutate(() => unwrap(api.DELETE("/v1/api-keys/{id}", { params })), {
              onSuccess: () => {
                toast("API key deleted");
                headingRef.current?.focus();
              },
            });
            setRemoving(undefined);
          }}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </section>
  );
}

function KeyForm({
  problem,
  onSave,
  onCancel,
}: {
  problem: string | undefined;
  onSave: (input: z.output<typeof apiKeyInput>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<z.input<typeof apiKeyInput>, unknown, z.output<typeof apiKeyInput>>({
    resolver: zodResolver(apiKeyInput),
    defaultValues: { name: "", scope: "read" },
  });
  const { errors, isSubmitting } = form.formState;
  const draft = useDraft("api-key:new", "Make an API key", form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onSave(values))) return;
    draft.discard();
    form.reset({ name: "", scope: "read" });
  });

  return (
    <form
      onSubmit={submit}
      aria-label="Make an API key"
      className="mt-6 flex flex-col gap-4"
      noValidate
    >
      <Field
        id="api-key-name"
        label="Name"
        help="What uses it, like the deploy script."
        error={errors.name?.message}
        {...form.register("name")}
      />
      <FormSelect
        control={form.control}
        name="scope"
        label="Scope"
        help="A key never does more than you can."
        options={Object.entries(SCOPE).map(([value, label]) => ({
          value: value as keyof typeof SCOPE,
          label,
        }))}
      />
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? "Making…" : "Make API key"}
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
