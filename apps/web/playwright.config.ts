import { defineConfig, devices } from "@playwright/test";

const desktop = {
  ...devices["Desktop Chrome"],
  channel: "chrome",
  viewport: { width: 1280, height: 800 },
};
const phone = { ...desktop, viewport: { width: 390, height: 844 }, hasTouch: true };
const PHONE_SKIPS = ["**/layout.spec.ts"];

const BASE_URL = "http://localhost:3000";

// Run through `pnpm test:e2e`, which starts Postgres, migrates and seeds the local owner first.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The API takes signed-in changes from the dashboard's origin only. A browser says so itself;
    // `page.request` doesn't, and it shares these headers.
    extraHTTPHeaders: { origin: BASE_URL },
  },
  // The installed Google Chrome (GitHub's Ubuntu runners have it too), so no browser download.
  // Every spec runs at 1280 and at 390 px (a phone), in light and dark. The layout spec sets its
  // own phone viewport and checks the desktop sidebar, so it runs at desktop width only.
  projects: [
    { name: "light", use: { ...desktop, colorScheme: "light" } },
    { name: "dark", use: { ...desktop, colorScheme: "dark" } },
    { name: "phone-light", use: { ...phone, colorScheme: "light" }, testIgnore: PHONE_SKIPS },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" }, testIgnore: PHONE_SKIPS },
  ],
  webServer: [
    {
      // The API, the jobs and the hot path in one process, with a simulated minute every 2 s so
      // an outage shows within seconds. Known limit: never reused, so stop `pnpm dev` first.
      command:
        "node --env-file-if-exists=../api/.env --import ../../scripts/register-tsx.mjs ../../scripts/dev.ts",
      url: "http://localhost:8787/health",
      reuseExistingServer: false,
      // Loopback lets a monitor target the test's own server.
      env: {
        GLN_AUTH_SECRET: "e2e-only-secret-at-least-32-characters",
        GLN_ALLOW_LOOPBACK: "1",
        GLN_TICK_SECONDS: "2",
        GLN_CANARY_URL: "http://127.0.0.1:8787/health",
      },
    },
    {
      command: "pnpm --filter @galena/web dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      // The project's own site, so the landing page is there to test.
      env: { GLN_SITE: "project" },
    },
  ],
});
