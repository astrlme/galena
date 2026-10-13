import type { Metadata } from "next";
import { IntegrationsEditor } from "./integrations-editor.tsx";

export const metadata: Metadata = { title: "Integrations" };

export default function Integrations() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Integrations</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        Alert sources that open incidents for you. Point Alertmanager, or anything that can send
        JSON, at an integration's hook URL; its routes decide which components an alert marks.
      </p>
      <IntegrationsEditor />
    </>
  );
}
