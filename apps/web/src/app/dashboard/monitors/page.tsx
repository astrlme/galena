import type { Metadata } from "next";
import { MonitorsEditor } from "./monitors-editor.tsx";

export const metadata: Metadata = { title: "Monitors" };

export default function Monitors() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Monitors</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Each monitor is checked every minute from three regions. It counts as down only when at
        least two regions agree.
      </p>
      <MonitorsEditor />
    </>
  );
}
