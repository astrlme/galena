import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// Where `next dev` forwards API calls. In AWS, CloudFront does this on the same origin.
const api = process.env.GLN_API_ORIGIN ?? "http://localhost:8787";

const config: NextConfig = {
  output: "export",
  trailingSlash: true, // /dashboard/ becomes dashboard/index.html, which S3 can serve
  transpilePackages: ["@galena/contracts", "@galena/core", "@galena/ui"],
  // The dev badge sits over the bottom-left corner, where a phone's form buttons are.
  devIndicators: false,
  // The project's own site (landing page and docs) is exported next to the dashboard's build.
  ...(process.env.GLN_SITE === "project" ? { distDir: "out-site" } : {}),
  ...(process.env.NODE_ENV === "development"
    ? {
        rewrites: async () => [
          { source: "/auth/:path*", destination: `${api}/auth/:path*` },
          { source: "/v1/:path*", destination: `${api}/v1/:path*` },
        ],
      }
    : {}),
};

// The docs under /docs are MDX in content/docs, compiled at build time.
export default createMDX()(config);
