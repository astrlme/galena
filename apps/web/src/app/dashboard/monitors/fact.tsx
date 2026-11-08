import type { ReactNode } from "react";

/** One fact, as a monitor page's header shows them: what it is, then its value. */
export function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[14px] text-slate">{name}</dt>
      <dd className="text-[14px] tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
