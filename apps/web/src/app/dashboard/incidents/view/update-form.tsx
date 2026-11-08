"use client";

import { type IncidentStatus, incidentUpdateCreate } from "@galena/contracts";
import { nextStatuses } from "@galena/core";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../../components/button.tsx";
import { FormSelect } from "../../../../components/ui/select.tsx";
import { toast } from "../../../../components/ui/toast.tsx";
import { api, unwrap } from "../../../../lib/api.ts";
import { bodyChecked } from "../incident-form.tsx";
import { type Affected, ComponentPicker, componentNames, STATUS_LABELS } from "../incident-ui.tsx";
import { MessageField, useTemplate } from "../message-field.tsx";
import type { IncidentDetail } from "./evidence.ts";

const schema = incidentUpdateCreate.extend({
  body: incidentUpdateCreate.shape.body.pipe(bodyChecked),
});
type FormIn = z.input<typeof schema>;
type FormOut = z.output<typeof schema>;

/** A new update: its status, the components it affects and its words, from the status's template. */
export function UpdateForm({
  incident,
  components,
  variant,
}: {
  incident: IncidentDetail;
  components: { id: string; name: string }[];
  /** Secondary on a draft, where approving is the view's one primary action. */
  variant: "primary" | "secondary";
}) {
  const queryClient = useQueryClient();
  const [affected, setAffected] = useState<Affected[]>(incident.components);
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
      // The form remounts once the new update arrives, so the toast carries the news.
      toast("Update posted");
      await queryClient.invalidateQueries({ queryKey: ["incidents"] });
    },
  });
  const submit = form.handleSubmit((values) => post.mutateAsync(values).catch(() => {}));

  return (
    <form onSubmit={submit} aria-label="Post an update" className="flex flex-col gap-4" noValidate>
      <FormSelect
        control={form.control}
        name="status"
        label="Status"
        options={nextStatuses(incident.status).map((next) => ({
          value: next,
          label: STATUS_LABELS[next],
        }))}
      />
      <ComponentPicker components={components} value={affected} onChange={setAffected} />
      <MessageField
        id="update-body"
        error={form.formState.errors.body?.message ?? post.error?.message}
        registration={form.register("body")}
      />
      <div>
        <Button type="submit" variant={variant} disabled={post.isPending}>
          {post.isPending ? "Posting…" : "Post update"}
        </Button>
      </div>
    </form>
  );
}
