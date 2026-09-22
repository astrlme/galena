import type { Metadata } from "next";
import { ButtonLink } from "../../components/button.tsx";

export const metadata: Metadata = { title: "Overview" };

export default function Overview() {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">Overview</h1>
      <section className="mt-8 flex max-w-[72ch] flex-col items-start gap-4 rounded-[8px] border border-mist bg-surface p-6">
        <p className="text-[16px] leading-[1.55]">
          No monitors yet. Add a URL and Galena checks it every minute from 3 regions.
        </p>
        <ButtonLink href="/dashboard/monitors/" variant="primary">
          Add monitor
        </ButtonLink>
      </section>
    </>
  );
}
