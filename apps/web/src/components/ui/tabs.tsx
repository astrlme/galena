"use client";

import { Tabs as Base } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { buttonClass } from "../button.tsx";

/**
 * A row of tabs over one panel, styled like the list's filter buttons: the chosen tab has an
 * `ink` border. Arrow keys move between tabs; the panel shows the chosen one's content.
 */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  children,
}: {
  label: string;
  value: T;
  tabs: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <Base.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <Base.List aria-label={label} className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Base.Tab
            key={tab.value}
            value={tab.value}
            className={`${buttonClass("secondary")} min-h-[44px] md:min-h-9 md:py-1 aria-selected:border-ink aria-selected:font-semibold`}
          >
            {tab.label}
          </Base.Tab>
        ))}
      </Base.List>
      <Base.Panel value={value} className="mt-4">
        {children}
      </Base.Panel>
    </Base.Root>
  );
}
