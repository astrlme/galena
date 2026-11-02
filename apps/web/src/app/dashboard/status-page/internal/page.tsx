import type { Metadata } from "next";
import { InternalAccess } from "./internal-access.tsx";

export const metadata: Metadata = { title: "Internal page" };

export default function Internal() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Internal page</h1>
      <p className="mt-2 max-w-[72ch] text-[16px] text-slate">
        The status page as members see it: internal-only monitors and internal incidents too.
        Opening this page lets your browser in for 12 hours. Bookmark this page, not the internal
        page itself.
      </p>
      <InternalAccess />
    </>
  );
}
