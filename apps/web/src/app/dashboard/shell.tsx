"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Activity,
  Globe,
  House,
  LogOut,
  type LucideIcon,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Drawer } from "vaul";
import { DraftDock, forgetDrafts } from "../../components/drafts.tsx";
import { PHONE_SCRIM } from "../../components/modal.tsx";
import { Loading } from "../../components/ui/loading.tsx";
import { Toasts } from "../../components/ui/toast.tsx";
import { Wordmark } from "../../components/wordmark.tsx";
import { api, authPost, demo } from "../../lib/api.ts";
import { CommandPalette } from "./command-palette.tsx";
import { isCurrent, type SectionKey, sections } from "./sections.ts";
import { modKey, ShortcutHelp, useShortcuts } from "./shortcuts.tsx";

// No triangle for incidents: ▲ is the partial-outage glyph.
const ICONS: Record<SectionKey, LucideIcon> = {
  home: House,
  incidents: Megaphone,
  monitors: Activity,
  "status-page": Globe,
  integrations: Plug,
  settings: Settings,
};
const icon = { "aria-hidden": true, size: 20, strokeWidth: 1.5, className: "shrink-0" } as const;
// 10 + 20 + 10 px fills the rail's 40 px, so each icon sits centred in it.
const row =
  "flex items-center gap-3 whitespace-nowrap rounded-[6px] px-2.5 py-1.5 text-left transition-colors duration-[120ms] motion-reduce:transition-none";
const quiet = "text-graphite hover:bg-surface hover:text-ink active:bg-mist active:text-ink";
// The menu drawer floats 8 px off the edges and the notch; vaul starts it that much further out.
const FROM_LEFT = {
  "--initial-transform": "calc(100% + 8px + env(safe-area-inset-left, 0px))",
} as CSSProperties;
// The frame: a bar below 768 px, the sidebar from there. The loading state draws it too. Both
// stay in reach while the page scrolls, measured in `dvh` (the height the browser shows now),
// clear of a notch or the status bar. The page behind the notch keeps the paper colour.
const frame =
  "flex min-h-dvh flex-col pr-[env(safe-area-inset-right,0px)] pl-[env(safe-area-inset-left,0px)] md:flex-row";
const bar =
  "sticky top-0 z-30 flex items-center justify-between border-mist border-b bg-paper px-4 pt-[max(0.5rem,env(safe-area-inset-top,0px))] pb-2 md:hidden";
const sidebar =
  "sticky top-0 hidden h-dvh shrink-0 flex-col gap-8 overflow-y-auto overflow-x-hidden border-mist border-r px-3 py-6 md:flex";
const slide = "transition-[width] duration-[120ms] ease-out motion-reduce:transition-none";
// Room at the foot for the drafts dock.
const content = "w-full min-w-0 p-4 pb-24 md:p-8 md:pb-24";
const block = "block rounded-[6px] bg-mist";

// Whether the sidebar is a rail, kept in this browser; storage can be blocked, so it opens wide.
const SIDEBAR = "galena:sidebar";
function readCollapsed(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(SIDEBAR) === "collapsed";
  } catch {
    return false;
  }
}
const noChanges = () => () => {};

type Me = { email: string; role: string; workspaceName: string };

/** The section links. In the rail each shows its icon, named for assistive tech and on hover. */
function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-1">
      {sections.map((section) => {
        const { key, href, title } = section;
        const Icon = ICONS[key];
        const current = isCurrent(section, pathname);
        return (
          <li key={key}>
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

/**
 * The frame with still blocks where its parts will be, until `/v1/me` answers: up to 15 s after
 * the database's idle pause, which `Loading` explains once 10 s have passed.
 */
function LoadingFrame({ unreachable }: { unreachable: boolean }) {
  // The static page is drawn wide; a stored rail applies once the page runs, without sliding.
  const collapsed = useSyncExternalStore(noChanges, readCollapsed, () => false);
  return (
    <div data-dashboard="" className={frame}>
      <header className={bar}>
        <Wordmark />
        <span aria-hidden="true" className="flex min-h-11 items-center gap-6">
          <span className={`${block} size-6`} />
          <span className={`${block} h-6 w-20`} />
        </span>
      </header>
      <div aria-hidden="true" className={`${sidebar} ${collapsed ? "w-16" : "w-[240px]"}`}>
        <div className="flex flex-col gap-3 px-2">
          <Wordmark markOnly={collapsed} />
          {!collapsed && <span className={`${block} h-4 w-24`} />}
        </div>
        <div className="flex flex-col gap-1">
          {["search", ...sections.map((s) => s.key)].map((key) => (
            <span key={key} className={`${block} h-8`} />
          ))}
        </div>
      </div>
      <main className={content}>
        {unreachable ? (
          <p role="alert" className="text-slate">
            Couldn't load your workspace. Check your connection, then reload the page.
          </p>
        ) : (
          <>
            <span aria-hidden="true" className={`${block} h-8 w-40`} />
            <Loading label="Loading your workspace" />
          </>
        )}
      </main>
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  const [me, setMe] = useState<Me>();
  const [unreachable, setUnreachable] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useShortcuts({ openPalette, openHelp });

  useEffect(() => {
    api
      .GET("/v1/me")
      .then(({ data, response }) =>
        response.status === 401 || !data ? router.replace("/sign-in/") : setMe(data),
      )
      .catch(() => setUnreachable(true));
  }, [router]);

  if (!me) return <LoadingFrame unreachable={unreachable} />;

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
      <Toasts>
        <div data-dashboard="" className={frame}>
          {/* Below 768 px: a bar whose menu opens the same links in a drawer from the left. */}
          <header className={bar}>
            <Wordmark />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-keyshortcuts="Control+K Meta+K"
              className={`${row} ml-auto min-h-11 min-w-11 justify-center hover:bg-surface active:bg-mist`}
            >
              <Search {...icon} />
              <span className="sr-only">Search</span>
            </button>
            <Drawer.Root open={menuOpen} onOpenChange={setMenuOpen} direction="left">
              <Drawer.Trigger
                className={`${row} min-h-11 font-semibold hover:bg-surface active:bg-mist`}
              >
                <Menu {...icon} />
                Menu
              </Drawer.Trigger>
              <Drawer.Portal>
                <Drawer.Overlay className={PHONE_SCRIM} />
                <Drawer.Content
                  aria-describedby={undefined}
                  style={FROM_LEFT}
                  className="fixed top-[calc(0.5rem+env(safe-area-inset-top,0px))] bottom-[calc(0.5rem+env(safe-area-inset-bottom,0px))] left-[calc(0.5rem+env(safe-area-inset-left,0px))] z-50 flex w-[min(280px,calc(100vw-4rem))] flex-col gap-6 overflow-y-auto overscroll-contain rounded-2xl border border-mist bg-surface px-3 py-5 text-ink outline-none"
                >
                  <Drawer.Title className="flex flex-col gap-2 px-2.5">
                    <Wordmark />
                    <span className="text-[14px] font-semibold">{me.workspaceName}</span>
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
            className={`${sidebar} ${slide} ${collapsed ? "w-16" : "w-[240px]"}`}
          >
            <div className="flex flex-col gap-3 px-2">
              <Wordmark markOnly={collapsed} />
              {/* The workspace this dashboard belongs to; the title shows a name cut short. */}
              <span
                title={me.workspaceName}
                className={collapsed ? "sr-only" : "truncate text-[14px] font-semibold"}
              >
                {me.workspaceName}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title={collapsed ? `Search (${modKey()} K)` : undefined}
                aria-label="Search"
                aria-keyshortcuts="Control+K Meta+K"
                className={`${row} w-full ${quiet}`}
              >
                <Search {...icon} />
                <span
                  className={collapsed ? "sr-only" : "flex flex-1 items-center justify-between"}
                >
                  Search
                  <kbd className="font-sans text-[13px] text-slate">{modKey()} K</kbd>
                </span>
              </button>
              <NavLinks collapsed={collapsed} />
            </div>
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
          <main className={content}>
            {demo && (
              <p className="mb-6 rounded-xl border border-mist bg-surface px-4 py-3 text-[14px] text-graphite">
                A demo with sample data. Changes aren't saved.{" "}
                <a href="https://galena.astrl.me/" className="text-ink underline">
                  About Galena
                </a>
              </p>
            )}
            {me.role === "viewer" && !demo && (
              <p className="mb-6 max-w-[72ch] rounded-xl border border-mist bg-surface px-4 py-3 text-[14px] text-graphite">
                You can view this workspace. Ask an owner or an admin to change your role to make
                changes.
              </p>
            )}
            {children}
          </main>
        </div>
        <DraftDock />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      </Toasts>
    </QueryClientProvider>
  );
}
