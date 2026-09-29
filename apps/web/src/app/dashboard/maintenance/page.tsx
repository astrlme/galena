import type { Metadata } from "next";
import { MaintenanceEditor } from "./maintenance-editor.tsx";

export const metadata: Metadata = { title: "Maintenance" };

export default function Maintenance() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Maintenance</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Schedule work ahead of time. A window starts and completes on its own; while it runs, its
        components show Maintenance and their monitors don't open incidents.
      </p>
      <MaintenanceEditor />
    </>
  );
}
