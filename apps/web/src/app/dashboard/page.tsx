import type { Metadata } from "next";
import { OverviewSummary } from "./overview.tsx";

export const metadata: Metadata = { title: "Home" };

export default function Overview() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Home</h1>
      <OverviewSummary />
    </>
  );
}
