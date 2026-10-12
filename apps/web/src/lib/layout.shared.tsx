import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import type { Metadata } from "next";
import { Wordmark } from "../components/wordmark.tsx";

// The project's own site. Every deployment carries a copy of the docs, and their canonical
// addresses point here, so search engines list one copy.
export const siteUrl = "https://galena.astrl.me";

// The link preview the landing page and the docs share; each page adds its title and address.
export const openGraph = {
  siteName: "Galena",
  type: "website",
  images: [
    {
      url: "/social-card.png",
      width: 1200,
      height: 630,
      alt: "Galena: picks the signal out of the noise",
    },
  ],
} satisfies Metadata["openGraph"];

// The header the landing page and the docs share.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Wordmark size={20} /> },
    // A text link: Fumadocs' GitHub icon is an unnamed image to screen readers.
    links: [{ text: "GitHub", url: "https://github.com/astrlme/galena", external: true }],
  };
}
