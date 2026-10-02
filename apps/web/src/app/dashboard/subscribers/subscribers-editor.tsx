"use client";

import { endpointInput } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { control, Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";
import { Time } from "../incidents/incident-ui.tsx";

type Endpoint =
  paths["/v1/webhook-endpoints"]["get"]["responses"][200]["content"]["application/json"][number];
type Subscriber =
  paths["/v1/subscribers"]["get"]["responses"][200]["content"]["application/json"][number];

const STATE: Record<Subscriber["state"], string> = {
  pending_confirmation: "Waiting for confirmation",
  active: "Subscribed",
  unsubscribed: "Unsubscribed",
  suppressed: "Stopped: the address bounced or reported spam",
};
const KIND: Record<Endpoint["kind"], string> = { slack: "Slack", webhook: "Webhook" };
const small = "px-2 py-1 text-[14px]";
const heading = "text-[19px] font-semibold leading-[1.35]";
const card = "mt-4 rounded-xl border border-mist bg-surface";
const empty = `${card} p-4 text-[14px] text-slate`;
const row =
  "flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-3 last:border-b-0";

export function SubscribersEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string }>();
  const [tested, setTested] = useState<{ id: string; detail: string }>();
  const [removing, setRemoving] = useState<{ endpoint?: Endpoint; subscriber?: Subscriber }>({});
  const endpoints = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: () => unwrap(api.GET("/v1/webhook-endpoints")),
  });
  const subscribers = useQuery({
    queryKey: ["subscribers"],
    queryFn: () => unwrap(api.GET("/v1/subscribers")),
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  const change = useMutation({
    mutationFn: (call: () => Promise<unknown>) => call(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({
        predicate: (q) => ["webhook-endpoints", "subscribers"].includes(String(q.queryKey[0])),
      });
    },
    onError: (error) => setProblem(error.message),
  });

  if (endpoints.isPending || subscribers.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading subscribers</p>;
  }
  const failed = endpoints.error ?? subscribers.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const following = (ids: string[]) =>
    ids.length === 0
      ? "All components"
      : ids.map((id) => all.find((c) => c.id === id)?.name ?? "A deleted component").join(", ");

  const test = async (endpoint: Endpoint) => {
    setTested({ id: endpoint.id, detail: "Sending a test message…" });
    const result = await unwrap(
      api.POST("/v1/webhook-endpoints/{id}/test", { params: { path: { id: endpoint.id } } }),
    ).catch((error: Error) => ({ detail: error.message }));
    setTested({ id: endpoint.id, detail: result.detail });
  };

  return (
    <>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {adding ? undefined : problem}
      </p>
      <section aria-labelledby="destinations" className="mt-8">
        <div className="flex items-center justify-between gap-4">
          <h2 id="destinations" className={heading}>
            Slack and webhooks
          </h2>
          <Button
            variant="primary"
            onClick={() => {
              setProblem(undefined);
              setSecret(undefined);
              setAdding(true);
            }}
          >
            Add destination
          </Button>
        </div>
        {endpoints.data?.length === 0 ? (
          <p className={empty}>
            None yet. Add a Slack channel's incoming webhook, or a URL to receive signed webhooks.
          </p>
        ) : (
          <ul className={card}>
            {endpoints.data?.map((e) => (
              <li key={e.id} className={row}>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-semibold">{e.name}</span>
                  <span className="text-[14px]">
                    {KIND[e.kind]}.{" "}
                    {e.state === "failing" && e.failingSince ? (
                      <>
                        Failing since <Time iso={e.failingSince} />.
                      </>
                    ) : e.state === "disabled" ? (
                      "Disabled."
                    ) : (
                      "Active."
                    )}{" "}
                    {following(e.componentIds)}.
                  </span>
                  {tested?.id === e.id && (
                    <span className="text-[14px]" aria-live="polite">
                      {tested.detail}
                    </span>
                  )}
                </div>
                <div className="ml-auto flex gap-2">
                  <Button className={small} onClick={() => void test(e)}>
                    Send test<span className="sr-only"> to {e.name}</span>
                  </Button>
                  <Button className={small} onClick={() => setRemoving({ endpoint: e })}>
                    Delete<span className="sr-only"> {e.name}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal.Root open={adding} onClose={() => setAdding(false)}>
        {secret ? (
          <>
            <Modal.Title>Signing secret for {secret.name}</Modal.Title>
            <div role="status" className="mt-4 flex flex-col gap-2">
              <p className="sr-only">Signing secret for {secret.name}</p>
              <p className="break-all rounded-[6px] border border-mist bg-paper p-3 font-mono text-[14px]">
                {secret.value}
              </p>
              <p className="text-[14px] text-slate">
                Copy it now: it isn't shown again. Your receiver checks each webhook's signature
                with it, using any Standard Webhooks library.
              </p>
            </div>
            <div className="mt-6">
              <Button variant="primary" onClick={() => setAdding(false)}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <Modal.Title>Add a destination</Modal.Title>
            <DestinationForm
              components={all}
              problem={adding ? problem : undefined}
              onCancel={() => setAdding(false)}
              onSave={(input) =>
                new Promise<boolean>((resolve) =>
                  change.mutate(
                    async () => {
                      const created = await unwrap(
                        api.POST("/v1/webhook-endpoints", { body: input }),
                      );
                      // A webhook's secret is shown once, here; a Slack channel needs none.
                      if (created.secret) {
                        setSecret({ name: input.name, value: created.secret });
                      } else {
                        setAdding(false);
                      }
                    },
                    { onSuccess: () => resolve(true), onError: () => resolve(false) },
                  ),
                )
              }
            />
          </>
        )}
      </Modal.Root>

      <section aria-labelledby="email-subscribers" className="mt-8">
        <h2 id="email-subscribers" className={heading}>
          Email
        </h2>
        {subscribers.data?.length === 0 ? (
          <p className={empty}>
            Nobody yet. People subscribe from the Subscribe button on the status page.
          </p>
        ) : (
          <ul className={card}>
            {subscribers.data?.map((s) => (
              <li key={s.id} className={row}>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-semibold tabular-nums">{s.email}</span>
                  <span className="text-[14px]">
                    {STATE[s.state]}. {following(s.componentIds)}. Since <Time iso={s.createdAt} />.
                  </span>
                </div>
                <div className="ml-auto">
                  <Button className={small} onClick={() => setRemoving({ subscriber: s })}>
                    Delete<span className="sr-only"> {s.email}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {removing.endpoint && (
        <ConfirmDelete
          kind="destination"
          name={removing.endpoint.name}
          consequence="It stops getting incident and maintenance updates at once."
          onConfirm={() => {
            const params = { path: { id: removing.endpoint?.id ?? "" } };
            change.mutate(() => unwrap(api.DELETE("/v1/webhook-endpoints/{id}", { params })));
            setRemoving({});
          }}
          onClose={() => setRemoving({})}
        />
      )}
      {removing.subscriber && (
        <ConfirmDelete
          kind="subscriber"
          name={removing.subscriber.email}
          noun="address as shown"
          consequence="The address is forgotten. It can subscribe again from the status page."
          onConfirm={() => {
            const params = { path: { id: removing.subscriber?.id ?? "" } };
            change.mutate(() => unwrap(api.DELETE("/v1/subscribers/{id}", { params })));
            setRemoving({});
          }}
          onClose={() => setRemoving({})}
        />
      )}
    </>
  );
}

type Input = Omit<z.output<typeof endpointInput>, "componentIds"> & { componentIds: string[] };

function DestinationForm({
  components,
  problem,
  onSave,
  onCancel,
}: {
  components: { id: string; name: string }[];
  problem: string | undefined;
  onSave: (input: Input) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const form = useForm<z.input<typeof endpointInput>, unknown, z.output<typeof endpointInput>>({
    resolver: zodResolver(endpointInput),
    defaultValues: { kind: "slack", name: "", url: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const kind = form.watch("kind");
  const submit = form.handleSubmit(async (values) => {
    if (await onSave({ ...values, componentIds: selected })) {
      form.reset({ kind: values.kind, name: "", url: "" });
      setSelected([]);
    }
  });
  const toggle = (id: string, on: boolean) =>
    setSelected((now) => (on ? [...now, id] : now.filter((c) => c !== id)));

  return (
    <form
      onSubmit={submit}
      aria-label="Add a destination"
      className="mt-6 flex flex-col gap-4"
      noValidate
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="destination-kind" className="text-[14px] font-semibold">
          Kind
        </label>
        <select id="destination-kind" className={control} {...form.register("kind")}>
          <option value="slack">Slack incoming webhook</option>
          <option value="webhook">Outgoing webhook (signed)</option>
        </select>
      </div>
      <Field
        id="destination-name"
        label="Name"
        help={
          kind === "slack" ? "The channel it posts to, like #status." : "Who receives it, like Ops."
        }
        error={errors.name?.message}
        {...form.register("name")}
      />
      <Field
        id="destination-url"
        label="URL"
        type="url"
        help={
          kind === "slack"
            ? "From Slack's Incoming Webhooks app: https://hooks.slack.com/services/…"
            : "A public https:// address that accepts POST requests."
        }
        error={errors.url?.message}
        {...form.register("url")}
      />
      {components.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] font-semibold">
            Only these components (none ticked means all)
          </legend>
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
      )}
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? "Adding…" : "Add destination"}
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
