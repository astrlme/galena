import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Wordmark } from "../components/wordmark.tsx";

// The header the landing page and the docs share.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Wordmark size={20} /> },
    githubUrl: "https://github.com/astrlme/galena",
  };
}
