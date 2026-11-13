import { dark, light } from "@galena/ui/tokens";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DashboardShell } from "./shell.tsx";

// A deployment's own dashboard: nothing a search engine should list.
export const metadata: Metadata = { robots: { index: false, follow: false } };

// Edge to edge on a phone: the shell pads itself off the notch and the home indicator. On Android
// the keyboard shrinks the layout, so a bottom drawer and `dvh` stay above it as they do on iOS.
// The browser's bars take the page's own background; the dashboard follows the system theme.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: light.paper },
    { media: "(prefers-color-scheme: dark)", color: dark.paper },
  ],
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
