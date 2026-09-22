import type { Metadata } from "next";
import { sections } from "../sections.ts";

type Props = { params: Promise<{ section: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return sections.map(({ slug }) => ({ section: slug }));
}

async function titleOf({ params }: Props) {
  const { section } = await params;
  return sections.find((s) => s.slug === section)?.title ?? "Dashboard";
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  return { title: await titleOf(props) };
}

export default async function Section(props: Props) {
  return (
    <>
      <h1 className="text-[24px] font-semibold leading-[1.25]">{await titleOf(props)}</h1>
      <p className="mt-4 text-[16px] text-slate">
        Nothing here yet. This section arrives in a later release.
      </p>
    </>
  );
}
