import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "../../../../components/ui/loading.tsx";
import { IncidentView } from "./incident-view.tsx";

export const metadata: Metadata = { title: "Incident" };

// The id comes from the query string (?id=…): a static export can't build a page per incident.
export default function Incident() {
  return (
    <Suspense fallback={<Loading label="Loading incident" />}>
      <IncidentView />
    </Suspense>
  );
}
