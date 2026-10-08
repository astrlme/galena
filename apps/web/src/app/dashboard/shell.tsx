"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Boxes,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Drawer } from "vaul";
import { DraftDock, forgetDrafts } from "../../components/drafts.tsx";
import { Wordmark } from "../../components/wordmark.tsx";
import { api, authPost, demo } from "../../lib/api.ts";
import { sections } from "./sections.ts";

// No triangle for incidents: ▲ is the partial-outage glyph.
const ICONS: Record<(typeof sections)[number]["slug"], LucideIcon> = {
  incidents: Megaphone,
  maintenance: Wrench,
  monitors: Activity,
  components: Boxes,
  subscribers: Bell,
  settings: Settings,
};
const nav = [
  { href: "/dashboard/", title: "Overview", Icon: LayoutDashboard },
  ...sections.map((s) => ({
    href: `/dashboard/${s.slug}/`,
    title: s.title,
    Icon: ICONS[s.slug],
  })),
];
const icon = { "aria-hidden": true, size: 20, strokeWidth: 1.5, className: "shrink-0" } as const;
// 10 + 20 + 10 px fills the rail's 40 px, so each icon sits centred in it.
const row =
  "flex items-center gap-3 whitespace-nowrap rounded-[6px] px-2.5 py-1.5 text-left transition-colors duration-[120ms] motion-reduce:transition-none";
const quiet = "text-graphite hover:bg-surface hover:text-ink";
// The menu drawer floats 8 px off the edge; vaul starts it that much further out.
const FROM_LEFT = { "--initial-transform": "calc(100% + 8px)" } as CSSProperties;

// Whether the sidebar is a rail, kept in this browser; storage can be blocked, so it opens wide.
const SIDEBAR = "galena:sidebar";
function readCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(SIDEBAR) === "collapsed";
  } catch {
    return false;
  }
}

type Me = { email: string };

/** The section links. In the rail each shows its icon, named for assistive tech and on hover. */
function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-1">
      {nav.map(({ href, title, Icon }) => {
        const current = pathname === href;
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={() => onNavigate?.()}
              aria-current={current ? "page" : undefined}
              title={collapsed ? title : undefined}
              className={`${row} ${current ? "bg-mist font-semibold" : quiet}`}
            >
              <Icon {...icon} />
              <span className={collapsed ? "sr-only" : undefined}>{title}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  const [me, setMe] = useState<Me>();
  const [slow, setSlow] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    // Explain the wait once it passes 10 s (Aurora resuming).
    const timer = setTimeout(() => setSlow(true), 10_000);
    api
      .GET("/v1/me")
      .then(({ data, response }) =>
        response.status === 401 || !data ? router.replace("/sign-in/") : setMe(data),
      )
      .catch(() => setUnreachable(true))
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, [router]);

  if (!me) {
    return (
      <p className="p-8 text-[16px] text-slate" aria-live="polite">
        {unreachable
          ? "Couldn't load your workspace. Check your connection, then reload the page."
          : slow
            ? "Waking the database. This takes about 15 seconds after a quiet period."
            : "Loading your workspace"}
      </p>
    );
  }

  async function signOut() {
    // There is no one to sign out in the demo: back to the project's site.
    if (demo) return window.location.assign("https://galena.astrl.me/");
    await authPost("sign-out", {});
    forgetDrafts();
    window.location.assign("/sign-in/");
  }
  const toggle = () => {
    setCollapsed(!collapsed);
    try {
      localStorage.setItem(SIDEBAR, collapsed ? "open" : "collapsed");
    } catch {
      // Kept for this visit only.
    }
  };
  const signOutButton = (iconOnly: boolean) => (
    <button
      type="button"
      onClick={signOut}
      title={iconOnly ? "Sign out" : undefined}
      className={`${row} w-full ${quiet}`}
    >
      <LogOut {...icon} />
      <span className={iconOnly ? "sr-only" : undefined}>Sign out</span>
    </button>
  );

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex min-h-screen flex-col md:flex-row">
        {/* Below 768 px: a bar whose menu opens the same links in a drawer from the left. */}
        <header className="flex items-center justify-between border-mist border-b px-4 py-2 md:hidden">
          <Wordmark />
          <Drawer.Root open={menuOpen} onOpenChange={setMenuOpen} direction="left">
            <Drawer.Trigger className={`${row} font-semibold hover:bg-surface`}>
              <Menu {...icon} />
              Menu
            </Drawer.Trigger>
            <Drawer.Portal>
              <Drawer.Overlay className="fixed inset-0 z-50 bg-scrim/60 backdrop-blur-sm" />
              <Drawer.Content
                aria-describedby={undefined}
                style={FROM_LEFT}
                className="fixed inset-y-2 left-2 z-50 flex w-[min(280px,calc(100vw-4rem))] flex-col gap-6 overflow-y-auto rounded-2xl border border-mist bg-surface px-3 py-5 text-ink outline-none"
              >
                <Drawer.Title className="px-2.5">
                  <Wordmark />
                  <span className="sr-only"> menu</span>
                </Drawer.Title>
                <nav aria-label="Dashboard">
                  <NavLinks collapsed={false} onNavigate={() => setMenuOpen(false)} />
                </nav>
                <div className="mt-auto flex flex-col gap-1 text-[14px]">
                  <span className="truncate px-2.5 py-1.5 text-slate">{me.email}</span>
                  {signOutButton(false)}
                </div>
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
        </header>

        {/* From 768 px: the sidebar, which collapses to a rail of icons. */}
        <nav
          aria-label="Dashboard"
          className={`sticky top-0 hidden h-screen shrink-0 flex-col gap-8 overflow-y-auto overflow-x-hidden border-mist border-r px-3 py-6 transition-[width] duration-[120ms] ease-out motion-reduce:transition-none md:flex ${collapsed ? "w-16" : "w-[240px]"}`}
        >
          <span className="px-2">
            <Wordmark markOnly={collapsed} />
          </span>
          <NavLinks collapsed={collapsed} />
          <div className="mt-auto flex flex-col gap-1 text-[14px]">
            <button
              type="button"
              onClick={toggle}
              title={collapsed ? "Expand sidebar" : undefined}
              className={`${row} w-full ${quiet}`}
            >
              {collapsed ? <PanelLeftOpen {...icon} /> : <PanelLeftClose {...icon} />}
              <span className={collapsed ? "sr-only" : undefined}>
                {collapsed ? "Expand sidebar" : "Collapse sidebar"}
              </span>
            </button>
            {!collapsed && <span className="truncate px-2.5 py-1.5 text-slate">{me.email}</span>}
            {signOutButton(collapsed)}
          </div>
        </nav>
        {/* Room at the foot for the drafts dock. */}
        <main className="w-full max-w-[1080px] p-4 pb-24 md:p-8 md:pb-24">
          {demo && (
            <p className="mb-6 rounded-xl border border-mist bg-surface px-4 py-3 text-[14px] text-graphite">
              A demo with sample data. Changes aren't saved.{" "}
              <a href="https://galena.astrl.me/" className="text-ink underline">
                About Galena
              </a>
            </p>
          )}
          {children}
        </main>
      </div>
      <DraftDock />
    </QueryClientProvider>
  );
}
