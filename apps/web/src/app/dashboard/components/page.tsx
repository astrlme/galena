import type { Metadata } from "next";
import { ComponentsEditor } from "./components-editor.tsx";

export const metadata: Metadata = { title: "Components" };

export default function Components() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Components</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        The parts of your service people care about, in the order your status page shows them.
      </p>
      <ComponentsEditor />
    </>
  );
}
