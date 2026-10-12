import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { baseOptions } from "../../../lib/layout.shared.tsx";
import { source } from "../../../lib/source.ts";

export const metadata: Metadata = {
  title: { template: "%s | Galena docs", default: "Galena docs" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
