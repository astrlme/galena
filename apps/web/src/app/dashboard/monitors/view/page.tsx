import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "../../../../components/ui/loading.tsx";
import { MonitorView } from "./monitor-view.tsx";

export const metadata: Metadata = { title: "Monitor" };

// The id comes from the query string (?id=…): a static export can't build a page per monitor.
export default function Monitor() {
  return (
    <Suspense fallback={<Loading label="Loading monitor" />}>
      <MonitorView />
    </Suspense>
  );
}
