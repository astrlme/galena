import type { ReactNode } from "react";

/** An empty list says what to do next; at most one action, when the section has none of its own. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-4 flex flex-col items-start gap-4 rounded-xl border border-mist bg-surface p-4">
      <p className="max-w-[72ch] text-[14px] text-slate">{children}</p>
      {action}
    </div>
  );
}
