"use client";

import { Menu } from "@base-ui/react/menu";
import { Ellipsis } from "lucide-react";
import { Fragment } from "react";
import { usePortalContainer } from "./portal.tsx";

export type RowAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  /** Deletes or removes something: set apart at the foot, and confirmed in a dialog. */
  destructive?: boolean;
};

/**
 * A row's one control: ⋯ opens its actions. Named for the row ("Actions for API") so a screen
 * reader hears which row it acts on.
 */
export function RowMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const container = usePortalContainer();
  const firstDestructive = actions.findIndex((a) => a.destructive);
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Actions for ${name}`}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-[6px] text-graphite transition-colors duration-[120ms] hover:bg-mist hover:text-ink data-popup-open:bg-mist data-popup-open:text-ink motion-reduce:transition-none"
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
                  className="flex min-h-[44px] cursor-default items-center px-3 text-[16px] outline-none select-none data-highlighted:bg-mist data-disabled:text-slate"
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
