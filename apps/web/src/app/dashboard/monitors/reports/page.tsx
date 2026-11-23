import type { Metadata } from "next";
import { ReportsView } from "./reports-view.tsx";

export const metadata: Metadata = { title: "Uptime reports" };

export default function Reports() {
  return <ReportsView />;
}
