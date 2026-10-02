import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Wordmark } from "../components/wordmark.tsx";

// The header the landing page and the docs share.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Wordmark size={20} /> },
    // A text link: Fumadocs' GitHub icon is an unnamed image to screen readers.
    links: [{ text: "GitHub", url: "https://github.com/astrlme/galena", external: true }],
  };
}
