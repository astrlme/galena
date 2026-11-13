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
  // The project's own site (landing page and docs) and the demo dashboard are exported next to
  // the dashboard's build.
  ...(process.env.GLN_SITE === "project" ? { distDir: "out-site" } : {}),
  ...(process.env.GLN_SITE === "demo" ? { distDir: "out-demo" } : {}),
  // Inlined, so client code can tell the demo build apart.
  env: { GLN_SITE: process.env.GLN_SITE ?? "" },
  ...(process.env.NODE_ENV === "development"
    ? {
        // A phone on the local network opens the dev server by this machine's address, say
        // GLN_DEV_HOST=192.168.1.20; Next serves its dev assets to localhost only otherwise.
        ...(process.env.GLN_DEV_HOST ? { allowedDevOrigins: [process.env.GLN_DEV_HOST] } : {}),
        rewrites: async () => [
          { source: "/auth/:path*", destination: `${api}/auth/:path*` },
          { source: "/v1/:path*", destination: `${api}/v1/:path*` },
          // Heartbeat ping URLs carry the dashboard's address, as they do through CloudFront.
          { source: "/hb/:path*", destination: `${api}/hb/:path*` },
        ],
      }
    : {}),
};

// The docs under /docs are MDX in content/docs, compiled at build time.
export default createMDX()(config);
