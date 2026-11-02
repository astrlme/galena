"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/button.tsx";
import { openEditor } from "../../components/drafts.tsx";
import { Modal } from "../../components/modal.tsx";
import { editFocusedRow, focusRow } from "../../components/ui/row-menu.tsx";
import { actionAt, goTarget } from "./sections.ts";

// Single-key shortcuts can be switched off (speech input says letters too), kept in this browser;
// storage can be blocked, so they stay on. Ctrl K takes a modifier and always works.
const SETTING = "galena:shortcuts";
const isOn = () => {
  try {
    return localStorage.getItem(SETTING) !== "off";
  } catch {
    return true;
  }
};

/** Whether single-key shortcuts are on in this browser, and a way to change it. */
function useShortcutsSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => setOn(isOn()), []);
  return [
    on,
    (next) => {
      setOn(next);
      try {
        localStorage.setItem(SETTING, next ? "on" : "off");
      } catch {
        // Kept for this visit only.
      }
    },
  ];
}

/** "⌘" on Apple devices, "Ctrl" elsewhere: how the search shortcut is written for this reader. */
export const modKey = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// A toast is a dialog too, but it never holds the keyboard.
const isDialogOpen = () =>
  Array.from(document.querySelectorAll('[role="dialog"]')).some(
    (dialog) => !dialog.closest("[data-toasts]"),
  );

/** While someone types, or a dialog, menu or list has the focus, keys belong to it. */
function isElsewhere(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]")) return true;
  if (target.closest('[role="menu"], [role="listbox"], [role="combobox"]')) return true;
  return isDialogOpen();
}

/**
 * The dashboard's keyboard: Ctrl/Cmd+K everywhere, and single keys unless they are switched off.
 * Approve has none on purpose: it publishes, so it always takes a deliberate press.
 */
export function useShortcuts({
  openPalette,
  openHelp,
}: {
  openPalette: () => void;
  openHelp: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const pendingG = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      // Even while typing in a field, but not over a sheet or dialog that holds the focus.
      if ((event.ctrlKey || event.metaKey) && key === "k") {
        if (isDialogOpen()) return;
        event.preventDefault();
        openPalette();
        return;
      }
      if (isElsewhere(event) || !isOn()) return;
      if (pendingG.current !== undefined) {
        window.clearTimeout(pendingG.current);
        pendingG.current = undefined;
        const href = goTarget(key);
        if (href) {
          event.preventDefault();
          router.push(href);
        }
        return;
      }
      const action = actionAt(pathname);
      if (key === "g") {
        pendingG.current = window.setTimeout(() => {
          pendingG.current = undefined;
        }, 1500);
      } else if (event.key === "?") {
        event.preventDefault();
        openHelp();
      } else if (key === "/") {
        event.preventDefault();
        openPalette();
      } else if (key === "c" && action) {
        event.preventDefault();
        openEditor(action.editor);
      } else if ((key === "j" || key === "k") && focusRow(key === "j" ? 1 : -1)) {
        event.preventDefault();
      } else if (key === "e" && editFocusedRow()) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, pathname, openPalette, openHelp]);
}

const keys = (mod: string): [string[], string][] => [
  [[`${mod} K`], "Search monitors, incidents, components and actions"],
  [["/"], `Search, like ${mod} K`],
  [["G", "H"], "Go to Home"],
  [["G", "I"], "Go to Incidents"],
  [["G", "M"], "Go to Monitors"],
  [["G", "S"], "Go to Status page"],
  [["C"], "Start this page's main action, such as Add monitor"],
  [["J"], "Next row"],
  [["K"], "Previous row"],
  [["E"], "Edit the row"],
  [["?"], "Show these shortcuts"],
];

const kbd =
  "inline-flex min-w-6 items-center justify-center rounded-[6px] border border-mist bg-paper px-1.5 font-sans text-[13px]";

/** What ? shows: every shortcut, why Approve has none, and where to turn single keys off. */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal.Root kind="dialog" open={open} onClose={onClose}>
      <Modal.Title>Keyboard shortcuts</Modal.Title>
      <dl className="mt-4 flex flex-col gap-2 text-[14px]">
        {keys(modKey()).map(([pressed, does]) => (
          <div key={does} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1">
              {pressed.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate">then</span>}
                  <kbd className={kbd}>{k}</kbd>
                </span>
              ))}
            </dt>
            <dd className="text-right">{does}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-[14px] text-slate">
        Approving a draft has no shortcut: it publishes, so it always takes a press. Turn single-key
        shortcuts off in Settings.
      </p>
      <div className="mt-6">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal.Root>
  );
}

/** The switch for single-key shortcuts, in Settings. */
export function ShortcutsSetting() {
  const [on, setOn] = useShortcutsSetting();
  return (
    <section aria-labelledby="shortcuts-title" className="mt-10 flex max-w-[72ch] flex-col gap-3">
      <h2 id="shortcuts-title" className="text-[19px] font-semibold leading-[1.35]">
        Keyboard
      </h2>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
          className="mt-1 accent-ink"
        />
        <span className="flex flex-col">
          <span className="font-semibold">Single-key shortcuts</span>
          <span className="text-[14px] text-slate">
            G, C, J, K, E, / and ? in this browser. Turn them off if you use speech input.{" "}
            {modKey()} K always opens search.
          </span>
        </span>
      </label>
    </section>
  );
}
