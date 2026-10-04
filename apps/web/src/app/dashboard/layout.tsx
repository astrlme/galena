import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DashboardShell } from "./shell.tsx";

// A deployment's own dashboard: nothing a search engine should list.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
