"use client";

import { type IncidentStatus, incidentUpdateCreate } from "@galena/contracts";
import { nextStatuses } from "@galena/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../../components/button.tsx";
import { StatusLabel } from "../../../../components/status.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import type { paths } from "../../../../lib/api-schema.ts";
import { bodyChecked } from "../incident-form.tsx";
import {
  type Affected,
  ComponentPicker,
  componentNames,
  IMPACT_LABELS,
  IMPACT_TITLE,
  STATUS_LABELS,
  select,
  Time,
} from "../incident-ui.tsx";
import { MessageField, useTemplate } from "../message-field.tsx";

// Updates on a vertical line, as on the status page: a dot each, the latest filled. Plain ink and
// greys, since incident statuses are not states.
const step =
  "relative pb-5 pl-6 last:pb-0 before:absolute before:top-5 before:bottom-0.5 before:left-[5px] before:w-px before:bg-mist last:before:hidden after:absolute after:top-[7px] after:left-0 after:size-[11px] after:rounded-full after:border-[1.5px] after:border-ash after:bg-paper first:after:border-ink first:after:bg-ink";

type Incident = paths["/v1/incidents/{id}"]["get"]["responses"][200]["content"]["application/json"];

export function IncidentView() {
  const id = useSearchParams().get("id") ?? "";
  const incident = useQuery({
    queryKey: ["incidents", id],
    queryFn: () => unwrap(api.GET("/v1/incidents/{id}", { params: { path: { id } } })),
    enabled: id !== "",
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });

  if (id === "") return <p className="mt-8 font-semibold">This link has no incident in it.</p>;
  if (incident.isPending || components.isPending) {
    return <p className="mt-8 text-slate">Loading incident</p>;
  }
  const failed = incident.error ?? components.error;
  if (failed) return <p className="mt-8 font-semibold">{failed.message}</p>;
  const all = components.data?.components ?? [];
  const nameOf = (componentId: string) =>
    all.find((c) => c.id === componentId)?.name ?? "A deleted component";
  const shown = incident.data;
  if (!shown) return null;

  return (
    <>
      <Link href="/dashboard/incidents/" className="text-[14px] underline-offset-2 hover:underline">
        All incidents
      </Link>
      <div className="mt-4 flex flex-col gap-2">
        <h1 className={`text-[24px] leading-[1.25] ${IMPACT_TITLE[shown.impact]}`}>
          {shown.title}
        </h1>
        <p className="text-[16px]">
          {STATUS_LABELS[shown.status]}. {IMPACT_LABELS[shown.impact]}. Started{" "}
          <Time iso={shown.startedAt} />
          {shown.resolvedAt && (
            <>
              , resolved <Time iso={shown.resolvedAt} />
            </>
          )}
          .
        </p>
      </div>
      {shown.components.length > 0 && (
        <ul aria-label="Affected components" className="mt-4 flex flex-wrap gap-3">
          {shown.components.map((c) => (
            <li key={c.componentId} className="flex items-center gap-2">
              {nameOf(c.componentId)} <StatusLabel status={c.status} />
            </li>
          ))}
        </ul>
      )}
      <UpdateForm key={shown.updates.length} incident={shown} components={all} />
      <section aria-labelledby="updates" className="mt-8">
        <h2 id="updates" className="border-b border-mist pb-2 text-[19px] font-semibold">
          Updates
        </h2>
        <ol className="mt-4">
          {shown.updates.map((update) => (
            <li key={update.id} className={step}>
              <span className="text-[14px]">
                <span className="font-semibold">{STATUS_LABELS[update.status]}</span>{" "}
                <span className="text-slate">
                  <Time iso={update.createdAt} />
                </span>
              </span>
              <p className="mt-1 max-w-[72ch] whitespace-pre-wrap">{update.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

const schema = incidentUpdateCreate.extend({
  body: incidentUpdateCreate.shape.body.pipe(bodyChecked),
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

function UpdateForm({
  incident,
  components,
}: {
  incident: Incident;
  components: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const [affected, setAffected] = useState<Affected[]>(incident.components);
  const [posted, setPosted] = useState<string>();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: { status: incident.status, body: "" },
  });
  const status = (form.watch("status") ?? incident.status) as IncidentStatus;
  useTemplate(status, componentNames(components, affected), form.watch("body") ?? "", (text) =>
    form.setValue("body", text),
  );
  const post = useMutation({
    mutationFn: (body: FormOut) =>
      unwrap(
        api.POST("/v1/incidents/{id}/updates", {
          params: { path: { id: incident.id } },
          body: { status: body.status, body: body.body, components: affected },
        }),
      ),
    onSuccess: async () => {
      setPosted("Update posted.");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
    onError: () => setPosted(undefined),
  });
  const submit = form.handleSubmit((values) => post.mutateAsync(values).catch(() => {}));

  if (incident.status === "postmortem") return null;
  return (
    <form
      onSubmit={submit}
      aria-label="Post an update"
      className="mt-8 flex max-w-[640px] flex-col gap-4"
      noValidate
    >
      <h2 className="text-[19px] font-semibold leading-[1.35]">Post an update</h2>
      <div className="flex flex-col gap-1">
        <label htmlFor="update-status" className="text-[14px] font-semibold">
          Status
        </label>
        <select id="update-status" className={select} {...form.register("status")}>
          {nextStatuses(incident.status).map((next) => (
            <option key={next} value={next}>
              {STATUS_LABELS[next]}
            </option>
          ))}
        </select>
      </div>
      <ComponentPicker components={components} value={affected} onChange={setAffected} />
      <MessageField
        id="update-body"
        error={errors(form.formState.errors.body?.message, post.error?.message)}
        registration={form.register("body")}
      />
      <div>
        <Button type="submit" variant="primary" disabled={post.isPending}>
          {post.isPending ? "Posting…" : "Post update"}
        </Button>
      </div>
      <p aria-live="polite" className="font-semibold empty:hidden">
        {posted}
      </p>
    </form>
  );
}

const errors = (...messages: (string | undefined)[]) => messages.find(Boolean);
