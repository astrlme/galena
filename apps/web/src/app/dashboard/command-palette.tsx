"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { openEditor } from "../../components/drafts.tsx";
import { control } from "../../components/field.tsx";
import { Modal } from "../../components/modal.tsx";
import { api, unwrap } from "../../lib/api.ts";
import { actions, places } from "./sections.ts";

type Command = { id: string; label: string; hint?: string; run: () => void };
type Group = { value: string; items: Command[] };

// Settings is one page; its parts are reached by their headings.
const SETTINGS_PARTS = [
  { title: "API keys", href: "/dashboard/settings/#api-keys-heading" },
  { title: "Slack", href: "/dashboard/settings/#slack-heading" },
];

/**
 * Ctrl/Cmd+K: find a monitor, incident or component by typing part of its name, or start a page's
 * main action. Each command goes where a person would; a monitor or an action also opens its form.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => unwrap(api.GET("/v1/monitors")),
    enabled: open,
  });
  const incidents = useQuery({
    queryKey: ["incidents", "open"],
    queryFn: () => unwrap(api.GET("/v1/incidents", { params: { query: { state: "open" } } })),
    enabled: open,
  });
  const components = useQuery({
    queryKey: ["components"],
    queryFn: () => unwrap(api.GET("/v1/components")),
    enabled: open,
  });

  const go = (href: string, editor?: string) => () => {
    onClose();
    if (editor) openEditor(editor);
    router.push(href);
  };
  const groups: Group[] = [
    {
      value: "Actions",
      items: actions.map((a) => ({
        id: `a:${a.label}`,
        label: a.label,
        run: go(a.href, a.editor),
      })),
    },
    {
      value: "Monitors",
      items: (monitors.data?.monitors ?? []).map((m) => ({
        id: `m:${m.id}`,
        label: m.name,
        hint: m.http.url,
        run: go("/dashboard/monitors/", `monitor:${m.id}`),
      })),
    },
    {
      value: "Open incidents",
      items: (incidents.data?.incidents ?? []).map((i) => ({
        id: `i:${i.id}`,
        label: i.title,
        run: go(`/dashboard/incidents/view/?id=${i.id}`),
      })),
    },
    {
      value: "Components",
      items: (components.data?.components ?? []).map((c) => ({
        id: `c:${c.id}`,
        label: c.name,
        run: go("/dashboard/status-page/components/"),
      })),
    },
    {
      value: "Go to",
      items: [...places, ...SETTINGS_PARTS].map((p) => ({
        id: `g:${p.title}`,
        label: p.title,
        run: go(p.href),
      })),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <Modal.Root kind="dialog" open={open} onClose={onClose}>
      <Modal.Title className="sr-only">Search the dashboard</Modal.Title>
      <Autocomplete.Root
        open
        inline
        items={groups}
        itemToStringValue={(c: Command) => c.label}
        autoHighlight="always"
        keepHighlight
      >
        <Autocomplete.Input
          aria-label="Search monitors, incidents, components and actions"
          placeholder="Search monitors, incidents, components and actions"
          className={`${control} w-full`}
        />
        <Autocomplete.Empty>
          <p className="mt-4 text-[14px] text-slate">Nothing matches. Try part of a name.</p>
        </Autocomplete.Empty>
        <Autocomplete.List className="mt-3 max-h-[min(60dvh,24rem)] overflow-y-auto">
          {(group: Group) => (
            <Autocomplete.Group key={group.value} items={group.items} className="mb-2">
              <Autocomplete.GroupLabel className="px-3 py-1 text-[13px] text-slate">
                {group.value}
              </Autocomplete.GroupLabel>
              <Autocomplete.Collection>
                {(item: Command) => (
                  <Autocomplete.Item
                    key={item.id}
                    value={item}
                    onClick={item.run}
                    className="flex min-h-[44px] cursor-default items-center justify-between gap-3 rounded-[6px] px-3 text-[16px] -outline-offset-2 select-none data-highlighted:bg-mist data-highlighted:outline-2 data-highlighted:outline-ink data-highlighted:outline-solid"
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint && (
                      <span className="hidden truncate text-[13px] text-graphite sm:inline">
                        {item.hint}
                      </span>
                    )}
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
        <p className="mt-2 text-[13px] text-slate">Enter opens the highlighted item. Esc closes.</p>
      </Autocomplete.Root>
    </Modal.Root>
  );
}
