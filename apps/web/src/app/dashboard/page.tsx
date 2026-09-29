import type { Metadata } from "next";
import { OverviewSummary } from "./overview.tsx";

export const metadata: Metadata = { title: "Overview" };

export default function Overview() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Overview</h1>
      <OverviewSummary />
    </>
  );
}
