"use client";

import { FilePen } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

// What someone typed into a form stays in this browser under `galena:draft:<key>` until it is
// sent or discarded, so minimizing the sheet, or closing the tab, loses nothing. Keys name the
// form: `monitor:new`, `monitor:<id>`. Storage can be blocked or full; the form works without it.
const PREFIX = "galena:draft:";
const CHANGED = "galena:drafts";

type Draft = { label: string; href: string; values: unknown };

function read(key: string): Draft | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, draft: Draft | undefined): void {
  try {
    if (draft) localStorage.setItem(PREFIX + key, JSON.stringify(draft));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Forgets a draft whose form can't open any more, such as one for a deleted monitor. */
export const forgetDraft = (key: string) => write(key, undefined);

/**
 * Restores the form's draft when it opens and keeps it while it changes (300 ms after the last
 * change, and at once when the form closes). `discard` drops it: after sending, or on Discard.
 */
export function useDraft<T extends FieldValues, Out>(
  key: string,
  label: string,
  form: UseFormReturn<T, unknown, Out>,
) {
  const discarded = useRef(false);
  useEffect(() => {
    const saved = read(key);
    if (saved) form.reset(saved.values as T, { keepDefaultValues: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      timer = undefined;
      if (discarded.current) return;
      const values = form.formState.isDirty ? form.getValues() : undefined;
      write(key, values && { label, href: window.location.pathname, values });
    };
    const watching = form.watch(() => {
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    });
    return () => {
      watching.unsubscribe();
      if (timer) {
        clearTimeout(timer);
        save();
      }
    };
  }, [key, label, form]);
  return {
    dirty: form.formState.isDirty,
    discard: () => {
      discarded.current = true;
      write(key, undefined);
    },
  };
}

const subscribe = (event: string) => (change: () => void) => {
  window.addEventListener(event, change);
  window.addEventListener("storage", change); // another tab
  return () => {
    window.removeEventListener(event, change);
    window.removeEventListener("storage", change);
  };
};

/** `[key, label, href]` for every draft, as a string so the snapshot compares by value. */
function listDrafts(): string {
  try {
    const keys = Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .sort();
    return JSON.stringify(
      keys.flatMap((k) => {
        const draft = read(k);
        return draft ? [[k, draft.label, draft.href]] : [];
      }),
    );
  } catch {
    return "[]";
  }
}

const onDraftsChange = subscribe(CHANGED);

// The dock asks the section's editor to open a draft; the editor takes it once its data loads.
let requested: string | undefined;
const REQUESTED = "galena:draft-requested";
const onRequest = subscribe(REQUESTED);
const setRequested = (key: string | undefined) => {
  requested = key;
  window.dispatchEvent(new Event(REQUESTED));
};

/**
 * Opens the draft the dock asked for when its key starts with `prefix:`. `open` gets the rest of
 * the key (`new` or an id) once `ready`, and says whether there was anything to open.
 */
export function useReopenDraft(prefix: string, ready: boolean, open: (id: string) => boolean) {
  const key = useSyncExternalStore(
    onRequest,
    () => requested,
    () => undefined,
  );
  const current = useRef(open);
  current.current = open;
  useEffect(() => {
    if (!ready || !key?.startsWith(`${prefix}:`)) return;
    setRequested(undefined);
    if (!current.current(key.slice(prefix.length + 1))) forgetDraft(key);
  }, [key, prefix, ready]);
}

/** Saved drafts, bottom right; each reopens its form. */
export function DraftDock() {
  const drafts = JSON.parse(useSyncExternalStore(onDraftsChange, listDrafts, () => "[]")) as [
    string,
    string,
    string,
  ][];
  if (drafts.length === 0) return null;
  return (
    <aside
      aria-label="Drafts"
      className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-wrap justify-end gap-2"
    >
      {drafts.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          onClick={() => setRequested(key)}
          className="inline-flex items-center gap-2 rounded-[6px] border border-mist bg-surface px-3 py-1.5 text-[14px] transition-colors duration-[120ms] hover:border-slate motion-reduce:transition-none"
        >
          <FilePen aria-hidden="true" size={16} strokeWidth={1.5} />
          {label}
        </Link>
      ))}
    </aside>
  );
}
