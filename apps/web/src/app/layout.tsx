import type { Metadata } from "next";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Downloaded at build time and served from our own origin, preloaded so they arrive before the
// first paint. next/font has no metrics for these faces, so the build warns that it skips sizing a
// fallback; the preload is what keeps the swap from moving anything.
const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin", "latin-ext"],
  variable: "--font-atkinson-next",
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-atkinson-mono",
});

export const metadata: Metadata = {
  title: "Galena",
  // The mark's set from the brand kit; favicon.svg switches to paper in a dark browser theme.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
