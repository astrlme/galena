"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A section's parts as a row of links above its pages; the current one is marked. */
export function SectionNav({
  label,
  parts,
}: {
  label: string;
  parts: readonly { title: string; href: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="mb-6 overflow-x-auto border-b border-mist">
      <ul className="flex gap-1">
        {parts.map(({ title, href }) => {
          const current = pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`-mb-px inline-flex min-h-[44px] items-center whitespace-nowrap border-b-2 px-3 text-[14px] ${current ? "border-ink font-semibold" : "border-transparent text-graphite hover:text-ink"}`}
              >
                {title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
