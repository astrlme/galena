import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

// The landing page and the docs. Search is a prebuilt index the browser downloads, since the
// site is a static export; the theme follows the reader's system unless they pick one, and sets
// both Fumadocs' `dark` class and our tokens' `data-theme`.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{ options: { type: "static", api: "/api/search.json" } }}
      theme={{ attribute: ["class", "data-theme"], defaultTheme: "system", enableSystem: true }}
    >
      {children}
    </RootProvider>
  );
}
