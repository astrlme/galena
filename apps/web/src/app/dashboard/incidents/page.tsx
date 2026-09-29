import type { Metadata } from "next";
import { IncidentsEditor } from "./incidents-editor.tsx";

export const metadata: Metadata = { title: "Incidents" };

export default function Incidents() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Incidents</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Tell people what is wrong, what you are doing about it and when they will hear more. While
        an incident is open, the components it names show the status you give them.
      </p>
      <IncidentsEditor />
    </>
  );
}
