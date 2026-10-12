import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/layout.shared.tsx";
import { source } from "../lib/source.ts";

// Built once into the export, like the docs search index.
export const revalidate = false;

// The landing page and every docs page, at the trailing-slash addresses the export serves.
// Other deployments list nothing: their robots.txt keeps crawlers out.
export default function sitemap(): MetadataRoute.Sitemap {
  if (process.env.GLN_SITE !== "project") return [];
  return ["/", ...source.getPages().map((page) => `${page.url}/`)].map((path) => ({
    url: `${siteUrl}${path}`,
  }));
}
