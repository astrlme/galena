"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/button.tsx";
import { DraftDock } from "../../components/drafts.tsx";
import { Wordmark } from "../../components/wordmark.tsx";
import { api, authPost } from "../../lib/api.ts";
import { sections } from "./sections.ts";

const nav = [
  { href: "/dashboard/", title: "Overview" },
  ...sections.map((s) => ({ href: `/dashboard/${s.slug}/`, title: s.title })),
];

type Me = { email: string };

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  const [me, setMe] = useState<Me>();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    // Explain the wait once it passes 10 s (Aurora resuming).
    const timer = setTimeout(() => setSlow(true), 10_000);
    api
      .GET("/v1/me")
      .then(({ data, response }) =>
        response.status === 401 || !data ? router.replace("/sign-in/") : setMe(data),
      )
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
    <QueryClientProvider client={queryClient}>
      {/* A sidebar from 768 px; above the content, with a row of links that scrolls, below. */}
      <div className="flex min-h-screen flex-col md:flex-row">
        <nav
          aria-label="Dashboard"
          className="flex w-full shrink-0 flex-col gap-4 border-mist border-b p-4 md:w-[240px] md:gap-8 md:border-r md:border-b-0 md:p-6"
        >
          <Wordmark />
          <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 py-1 md:mx-0 md:flex-col md:p-0">
            {nav.map((item) => {
              const current = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    className={`block whitespace-nowrap rounded-[6px] px-3 py-1.5 transition-colors duration-[120ms] motion-reduce:transition-none ${current ? "bg-mist font-semibold" : "text-graphite hover:bg-surface hover:text-ink"}`}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-2 text-[14px] md:mt-auto md:flex-col md:items-start">
            <span className="text-slate">{me.email}</span>
            <Button variant="quiet" className="justify-start px-0" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </nav>
        {/* Room at the foot for the drafts dock. */}
        <main className="w-full max-w-[1080px] p-4 pb-24 md:p-8 md:pb-24">{children}</main>
      </div>
      <DraftDock />
    </QueryClientProvider>
  );
}
