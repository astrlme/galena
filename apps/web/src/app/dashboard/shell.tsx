"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Wordmark } from "../../components/wordmark.tsx";
import { authPost, fetchMe, type Me } from "../../lib/api.ts";
import { sections } from "./sections.ts";

const nav = [
  { href: "/dashboard/", title: "Overview" },
  ...sections.map((s) => ({ href: `/dashboard/${s.slug}/`, title: s.title })),
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me>();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Explain the wait once it passes 10 s (Aurora resuming).
    const timer = setTimeout(() => setSlow(true), 10_000);
    fetchMe()
      .then((member) => (member ? setMe(member) : router.replace("/sign-in/")))
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, [router]);

  if (!me) {
    return (
      <p className="p-8 text-[16px] text-slate" aria-live="polite">
        {slow
          ? "Waking the database. This takes about 15 seconds after a quiet period."
          : "Loading your workspace"}
      </p>
    );
  }

  async function signOut() {
    await authPost("sign-out", {});
    window.location.assign("/sign-in/");
  }

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="Dashboard"
        className="flex w-[240px] shrink-0 flex-col gap-8 border-r border-mist p-6"
      >
        <Wordmark />
        <ul className="flex flex-col gap-1">
          {nav.map((item) => {
            const current = pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`block rounded-[4px] px-2 py-1 ${current ? "bg-mist font-semibold" : "text-graphite hover:underline"}`}
                >
                  {item.title}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto flex flex-col gap-2 text-[14px]">
          <span className="text-slate">{me.email}</span>
          <Button variant="quiet" className="justify-start px-0" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </nav>
      <main className="w-full max-w-[1080px] p-8">{children}</main>
    </div>
  );
}
