"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "../../components/button.tsx";
import { openEditor } from "../../components/drafts.tsx";
import { Modal } from "../../components/modal.tsx";
import { editFocusedRow, focusRow } from "../../components/ui/row-menu.tsx";

// G then a letter goes to a section.
const GO: Record<string, string> = {
  h: "/dashboard/",
  i: "/dashboard/incidents/",
  m: "/dashboard/monitors/",
  s: "/dashboard/status-page/components/",
};

// C opens the form a list page's primary action opens.
const CREATE: Record<string, string> = {
  "/dashboard/incidents/": "incident:new",
  "/dashboard/monitors/": "monitor:new",
  "/dashboard/status-page/components/": "component:new",
  "/dashboard/status-page/maintenance/": "maintenance:new",
  "/dashboard/status-page/subscribers/": "destination:new",
  "/dashboard/integrations/": "integration:new",
};

/** While someone types, or a dialog or menu has the focus, keys belong to it. */
function busy(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]")) return true;
  if (target.closest('[role="menu"], [role="listbox"]')) return true;
  // A toast is a dialog too, but it never holds the keyboard.
  return Array.from(document.querySelectorAll('[role="dialog"]')).some(
    (dialog) => !dialog.closest("[data-toasts]"),
  );
}

/**
 * The dashboard's single-key shortcuts. Approve has none on purpose: it publishes, so it always
 * takes a deliberate press.
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
      if (busy(event)) return;
      const key = event.key.toLowerCase();
      if (pendingG.current !== undefined) {
        window.clearTimeout(pendingG.current);
        pendingG.current = undefined;
        const href = GO[key];
        if (href) {
          event.preventDefault();
          router.push(href);
        }
        return;
      }
      if (key === "g") {
        pendingG.current = window.setTimeout(() => {
          pendingG.current = undefined;
        }, 1500);
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        openHelp();
      } else if (key === "/") {
        event.preventDefault();
        openPalette();
      } else if (key === "c" && CREATE[pathname]) {
        event.preventDefault();
        openEditor(CREATE[pathname]);
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

const KEYS: [string[], string][] = [
  [["Ctrl K"], "Search monitors, incidents and actions"],
  [["/"], "Search, the same"],
  [["G", "H"], "Go to Home"],
  [["G", "I"], "Go to Incidents"],
  [["G", "M"], "Go to Monitors"],
  [["G", "S"], "Go to Status page"],
  [["C"], "Add or publish in this list"],
  [["J"], "Next row"],
  [["K"], "Previous row"],
  [["E"], "Edit the row"],
  [["?"], "Show these shortcuts"],
];

const kbd =
  "inline-flex min-w-6 items-center justify-center rounded-[6px] border border-mist bg-paper px-1.5 font-sans text-[13px]";

/** What ? shows: every shortcut, and why Approve has none. */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal.Root kind="dialog" open={open} onClose={onClose}>
      <Modal.Title>Keyboard shortcuts</Modal.Title>
      <dl className="mt-4 flex flex-col gap-2 text-[14px]">
        {KEYS.map(([keys, does]) => (
          <div key={does} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1">
              {keys.map((k, i) => (
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
        Approving a draft has no shortcut: it publishes, so it always takes a press.
      </p>
      <div className="mt-6">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal.Root>
  );
}
