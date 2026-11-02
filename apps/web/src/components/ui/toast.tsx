"use client";

import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

const manager = Toast.createToastManager();

/** Says what just happened, named after the action that did it: "Publish incident" → "Incident published". */
export function toast(title: string): void {
  manager.add({ title });
}

/** Bottom left, without motion, for 6 s or until dismissed; announced politely. */
export function Toasts({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} timeout={6000}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          data-toasts=""
          className="fixed bottom-4 left-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
        >
          <List />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function List() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root key={t.id} toast={t} className="rounded-xl border border-ink bg-surface text-ink">
      <Toast.Content className="flex items-center gap-3 py-2 pr-2 pl-4">
        <Toast.Title className="flex-1 text-[14px] font-semibold" />
        <Toast.Close className="rounded-[6px] px-2 py-1 text-[14px] hover:underline focus-visible:underline">
          Dismiss
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}
