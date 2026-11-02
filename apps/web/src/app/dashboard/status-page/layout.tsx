import type { ReactNode } from "react";
import { SectionNav } from "../section-nav.tsx";
import { statusPageParts } from "../sections.ts";

export default function StatusPageLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SectionNav label="Status page" parts={statusPageParts} />
      {children}
    </>
  );
}
