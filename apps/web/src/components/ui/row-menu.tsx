"use client";

import { Menu } from "@base-ui/react/menu";
import { Ellipsis } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { usePortalContainer } from "./portal.tsx";

export type RowAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  /** Deletes or removes something: set apart at the foot, and confirmed in a dialog. */
  destructive?: boolean;
};

// Each row's actions, by its menu button, so the keyboard can act on the focused row.
const rowActions = new WeakMap<Element, RowAction[]>();
const ROW = "[data-row-menu]";

/** Moves focus to the next (1) or previous (-1) row's menu button in the page; false if none. */
export function focusRow(step: 1 | -1): boolean {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(`main ${ROW}`));
  if (rows.length === 0) return false;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[at === -1 ? (step === 1 ? 0 : rows.length - 1) : at + step];
  if (!next) return false;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

/** Runs the focused row's Edit, if it has one; false otherwise. */
export function editFocusedRow(): boolean {
  const focused = document.activeElement;
  const edit = focused && rowActions.get(focused)?.find((a) => a.label === "Edit" && !a.disabled);
  if (!edit) return false;
  edit.onSelect();
  return true;
}

/**
 * A row's one control: ⋯ opens its actions. Named for the row ("Actions for API") so a screen
 * reader hears which row it acts on.
 */
export function RowMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const container = usePortalContainer();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (trigger.current) rowActions.set(trigger.current, actions);
  });
  const firstDestructive = actions.findIndex((a) => a.destructive);
  return (
    <Menu.Root>
      <Menu.Trigger
        ref={trigger}
        data-row-menu=""
        aria-label={`Actions for ${name}`}
        className="inline-flex size-11 shrink-0 md:size-9 items-center justify-center rounded-[6px] text-graphite transition-colors duration-[120ms] hover:bg-mist hover:text-ink data-popup-open:bg-mist data-popup-open:text-ink motion-reduce:transition-none"
      >
        <Ellipsis aria-hidden="true" size={20} strokeWidth={1.5} />
      </Menu.Trigger>
      {/* Base UI waits for a container that is null; undefined means the body. */}
      <Menu.Portal container={container ?? undefined}>
        <Menu.Positioner align="end" sideOffset={4} className="z-[70]">
          <Menu.Popup className="min-w-[180px] rounded-xl border border-mist bg-surface py-1 text-ink outline-none">
            {actions.map((action, index) => (
              <Fragment key={action.label}>
                {index === firstDestructive && index > 0 && (
                  <Menu.Separator className="my-1 h-px bg-mist" />
                )}
                <Menu.Item
                  disabled={action.disabled ?? false}
                  onClick={action.onSelect}
                  className="flex min-h-[44px] cursor-default items-center px-3 text-[16px] -outline-offset-2 select-none data-highlighted:bg-mist data-disabled:text-slate"
                >
                  {action.label}
                </Menu.Item>
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
