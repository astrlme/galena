"use client";

import { type ComponentGroupInput, componentGroupInput, componentInput } from "@galena/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "../../../components/button.tsx";
import { ConfirmDelete } from "../../../components/confirm-delete.tsx";
import { useDraft, useReopenDraft } from "../../../components/drafts.tsx";
import { control, Field } from "../../../components/field.tsx";
import { Modal } from "../../../components/modal.tsx";
import { StatusLabel } from "../../../components/status.tsx";
import { api, unwrap } from "../../../lib/api.ts";
import type { paths } from "../../../lib/api-schema.ts";

type Listing = paths["/v1/components"]["get"]["responses"][200]["content"]["application/json"];
type Item = Listing["components"][number];
type Group = Listing["groups"][number];
type Deleting = { kind: "component" | "group"; id: string; name: string };

const small = "px-2 py-1 text-[14px]";

/** Swaps two ids in a full order, so a move sends the complete list the API expects. */
function swapped(ids: string[], a: string, b: string): string[] {
  const next = [...ids];
  const [i, j] = [next.indexOf(a), next.indexOf(b)];
  [next[i], next[j]] = [b, a];
  return next;
}

export function ComponentsEditor() {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string>();
  const [deleting, setDeleting] = useState<Deleting>();
  const [creating, setCreating] = useState<"group" | "component">();
  const listing = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setProblem(undefined);
      return queryClient.invalidateQueries({ queryKey: ["components"] });
    },
    onError: (error) => setProblem(error.message),
  });
  const reopen = (kind: "group" | "component") => (id: string) => {
    setProblem(undefined);
    if (id === "new") setCreating(kind);
    return id === "new";
  };
  useReopenDraft("group", listing.isSuccess, reopen("group"));
  useReopenDraft("component", listing.isSuccess, reopen("component"));

  /** Whether the call succeeded; a failure shows above the lists and the form keeps its values. */
  const run = (call: () => Promise<unknown>) =>
    new Promise<boolean>((resolve) =>
      change.mutate(call, { onSuccess: () => resolve(true), onError: () => resolve(false) }),
    );

  if (listing.isPending) return <p className="mt-8 text-slate">Loading components</p>;
  if (listing.isError) return <p className="mt-8 font-semibold">{listing.error.message}</p>;
  const { groups, components } = listing.data;
  const ids = components.map((c) => c.id);

  const move = (item: Item, siblings: Item[], step: -1 | 1) => {
    const other = siblings[siblings.indexOf(item) + step];
    if (!other) return;
    const order = swapped(ids, item.id, other.id);
    change.mutate(() => unwrap(api.PUT("/v1/components/order", { body: { ids: order } })));
  };
  const moveGroup = (group: Group, step: -1 | 1) => {
    const other = groups[groups.indexOf(group) + step];
    if (!other) return;
    const order = swapped(
      groups.map((g) => g.id),
      group.id,
      other.id,
    );
    change.mutate(() => unwrap(api.PUT("/v1/component-groups/order", { body: { ids: order } })));
  };
  const remove = ({ kind, id }: Deleting) =>
    change.mutate(() =>
      kind === "component"
        ? unwrap(api.DELETE("/v1/components/{id}", { params: { path: { id } } }))
        : unwrap(api.DELETE("/v1/component-groups/{id}", { params: { path: { id } } })),
    );

  const list = (items: Item[]) =>
    items.length === 0 ? (
      <p className="mt-4 rounded-xl border border-mist bg-surface p-4 text-[14px] text-slate">
        No components here yet.
      </p>
    ) : (
      <ul className="mt-4 rounded-xl border border-mist bg-surface">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex min-h-[44px] flex-wrap items-center gap-4 border-b border-mist px-4 py-2 last:border-b-0"
          >
            <div className="flex flex-col">
              <span className="font-semibold">{item.name}</span>
              {item.description && (
                <span className="text-[14px] text-slate">{item.description}</span>
              )}
            </div>
            <StatusLabel status={item.status} />
            <div className="ml-auto flex gap-2">
              <Button
                className={small}
                disabled={index === 0}
                onClick={() => move(item, items, -1)}
              >
                Move up<span className="sr-only"> {item.name}</span>
              </Button>
              <Button
                className={small}
                disabled={index === items.length - 1}
                onClick={() => move(item, items, 1)}
              >
                Move down<span className="sr-only"> {item.name}</span>
              </Button>
              <Button
                className={small}
                onClick={() => setDeleting({ kind: "component", id: item.id, name: item.name })}
              >
                Delete<span className="sr-only"> {item.name}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <div className="mt-8 flex gap-2">
        <Button
          onClick={() => {
            setProblem(undefined);
            setCreating("group");
          }}
        >
          Add group
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setProblem(undefined);
            setCreating("component");
          }}
        >
          Add component
        </Button>
      </div>
      <p aria-live="polite" className="mt-4 font-semibold text-major empty:hidden">
        {creating ? undefined : problem}
      </p>
      <Modal.Root open={creating !== undefined} onClose={() => setCreating(undefined)}>
        {creating === "group" ? (
          <>
            <Modal.Title>Add a group</Modal.Title>
            <GroupForm
              problem={problem}
              onCancel={() => setCreating(undefined)}
              onCreate={async (body) => {
                const done = await run(() => unwrap(api.POST("/v1/component-groups", { body })));
                if (done) setCreating(undefined);
                return done;
              }}
            />
          </>
        ) : (
          <>
            <Modal.Title>Add a component</Modal.Title>
            <ComponentForm
              groups={groups}
              problem={problem}
              onCancel={() => setCreating(undefined)}
              onCreate={async (body) => {
                const done = await run(() => unwrap(api.POST("/v1/components", { body })));
                if (done) setCreating(undefined);
                return done;
              }}
            />
          </>
        )}
      </Modal.Root>

      {groups.map((group, index) => (
        <section key={group.id} aria-labelledby={`group-${group.id}`} className="mt-8">
          <div className="flex items-center gap-4">
            <h2 id={`group-${group.id}`} className="text-[19px] font-semibold leading-[1.35]">
              {group.name}
            </h2>
            <div className="ml-auto flex gap-2">
              <Button className={small} disabled={index === 0} onClick={() => moveGroup(group, -1)}>
                Move up<span className="sr-only"> group {group.name}</span>
              </Button>
              <Button
                className={small}
                disabled={index === groups.length - 1}
                onClick={() => moveGroup(group, 1)}
              >
                Move down<span className="sr-only"> group {group.name}</span>
              </Button>
              <Button
                className={small}
                onClick={() => setDeleting({ kind: "group", id: group.id, name: group.name })}
              >
                Delete group<span className="sr-only"> {group.name}</span>
              </Button>
            </div>
          </div>
          {list(components.filter((c) => c.groupId === group.id))}
        </section>
      ))}
      <section aria-labelledby="ungrouped" className="mt-8">
        <h2 id="ungrouped" className="text-[19px] font-semibold leading-[1.35]">
          Not in a group
        </h2>
        {list(components.filter((c) => c.groupId === null))}
      </section>

      {deleting && (
        <ConfirmDelete
          kind={deleting.kind}
          name={deleting.name}
          consequence={
            deleting.kind === "component"
              ? `This removes ${deleting.name} from every status page. Its history goes with it.`
              : `This removes the group. Its components stay, listed under "Not in a group".`
          }
          onConfirm={() => {
            remove(deleting);
            setDeleting(undefined);
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}

function GroupForm({
  problem,
  onCreate,
  onCancel,
}: {
  problem: string | undefined;
  onCreate: (body: ComponentGroupInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<ComponentGroupInput>({
    resolver: zodResolver(componentGroupInput),
    defaultValues: { name: "" },
  });
  const draft = useDraft("group:new", "New group", form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onCreate(values))) return;
    draft.discard();
    form.reset();
  });
  return (
    <form
      onSubmit={submit}
      aria-label="Add a group"
      className="mt-6 flex flex-col gap-4"
      noValidate
    >
      <Field
        id="group-name"
        label="Group name"
        help="Groups collapse on the status page, e.g. Core platform."
        error={form.formState.errors.name?.message}
        {...form.register("name")}
      />
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Adding…" : "Add group"}
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

type ComponentFormIn = z.input<typeof componentInput>;
type ComponentFormOut = z.output<typeof componentInput>;

function ComponentForm({
  groups,
  problem,
  onCreate,
  onCancel,
}: {
  groups: Group[];
  problem: string | undefined;
  onCreate: (body: ComponentFormOut) => Promise<boolean>;
  onCancel: () => void;
}) {
  const form = useForm<ComponentFormIn, unknown, ComponentFormOut>({
    resolver: zodResolver(componentInput),
    defaultValues: { name: "", description: null, groupId: null },
  });
  const draft = useDraft("component:new", "New component", form);
  const submit = form.handleSubmit(async (values) => {
    if (!(await onCreate(values))) return;
    draft.discard();
    form.reset();
  });
  return (
    <form
      onSubmit={submit}
      aria-label="Add a component"
      className="mt-6 flex flex-col gap-4"
      noValidate
    >
      <Field
        id="component-name"
        label="Component name"
        help="What people call it, e.g. API or Checkout."
        error={form.formState.errors.name?.message}
        {...form.register("name")}
      />
      <Field
        id="component-description"
        label="Description (optional)"
        {...form.register("description", { setValueAs: (v: string) => (v?.trim() ? v : null) })}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="component-group" className="text-[14px] font-semibold">
          Group
        </label>
        <select
          id="component-group"
          className={control}
          {...form.register("groupId", { setValueAs: (v: string) => (v === "" ? null : v) })}
        >
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      <p aria-live="polite" className="font-semibold text-major empty:hidden">
        {problem}
      </p>
      <div className="flex gap-4">
        <Button type="submit" variant="primary" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? "Adding…" : "Add component"}
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
