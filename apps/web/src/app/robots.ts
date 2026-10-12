import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/layout.shared.tsx";

// Built once into the export, like the docs search index.
export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  // Every other deployment's address is a dashboard, with nothing for a search engine to list.
  if (process.env.GLN_SITE !== "project") return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${siteUrl}/sitemap.xml` };
}
