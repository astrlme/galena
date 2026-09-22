import type { ReactNode } from "react";
import { DashboardShell } from "./shell.tsx";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
