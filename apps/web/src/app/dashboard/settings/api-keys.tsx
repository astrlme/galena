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
import { control, Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { Time } from "../incidents/incident-ui.tsx";

const heading = "text-[19px] font-semibold leading-[1.35]";
const card = "mt-4 rounded-xl border border-mist bg-surface";
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

const SCOPE: Record<ApiKeyScope, string> = {
  read: "Read, like a viewer",
  write: "Write, like an editor: also creates and changes",
  admin: "Admin: also webhooks, subscribers, integrations and Slack",
};

type Key = paths["/v1/api-keys"]["get"]["responses"][200]["content"]["application/json"][number];

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
        <p className={`${card} p-4 text-slate`}>Loading the API keys</p>
      ) : keys.error ? (
        <p className={`${card} p-4 font-semibold`}>{keys.error.message}</p>
      ) : keys.data.length === 0 ? (
        <p className={`${card} p-4 text-[14px] text-slate`}>
          None yet. Make one key per script, so you can delete one without stopping the others.
        </p>
      ) : (
        <ul className={card}>
          {keys.data.map((k) => (
            <li key={k.id} className={row}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">{k.name}</span>
                <span className="text-[14px]">
                  {SCOPE[k.scope]}. Starts <span className="font-mono">{k.prefix}</span>. Made{" "}
                  <Time iso={k.createdAt} />.
                </span>
              </div>
              <div className="ml-auto">
                <Button className="px-2 py-1 text-[14px]" onClick={() => setRemoving(k)}>
                  Delete<span className="sr-only"> {k.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
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
                setNotice("API key deleted.");
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
      <div className="flex flex-col gap-1">
        <label htmlFor="api-key-scope" className="text-[14px] font-semibold">
          Scope
        </label>
        <select
          id="api-key-scope"
          aria-describedby="api-key-scope-help"
          className={control}
          {...form.register("scope")}
        >
          {Object.entries(SCOPE).map(([scope, label]) => (
            <option key={scope} value={scope}>
              {label}
            </option>
          ))}
        </select>
        <p id="api-key-scope-help" className="text-[14px] text-slate">
          A key never does more than you can.
        </p>
      </div>
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
