"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** A section's parts as a row of links above its pages; the current one is marked. */
export function SectionNav({
  label,
  parts,
}: {
  label: string;
  parts: readonly { title: string; href: string }[];
}) {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);
  // On a phone the row scrolls sideways: bring the current part into view, at once.
  useEffect(() => {
    const box = nav.current;
    const tab = box?.querySelector('[aria-current="page"]');
    if (!box || !tab || !pathname) return;
    const [edge, part] = [box.getBoundingClientRect(), tab.getBoundingClientRect()];
    if (part.right > edge.right) box.scrollLeft += part.right - edge.right;
    else if (part.left < edge.left) box.scrollLeft -= edge.left - part.left;
  }, [pathname]);
  return (
    // The rule sits on the list, so the current tab's underline overlaps it inside the scroll box.
    // A sideways swipe at either end stays in the row rather than going back a page.
    <nav ref={nav} aria-label={label} className="mb-6 overflow-x-auto overscroll-x-contain">
      <ul className="flex w-max min-w-full gap-1 border-b border-mist">
        {parts.map(({ title, href }) => {
          const current = pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`-mb-px inline-flex min-h-[44px] items-center whitespace-nowrap border-b-2 px-3 text-[14px] -outline-offset-2 ${current ? "border-ink font-semibold" : "border-transparent text-graphite hover:text-ink active:text-ink"}`}
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
