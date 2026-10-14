import { defineConfig, devices } from "@playwright/test";

// Run through `pnpm test:e2e`, which starts Postgres, migrates and seeds the local owner first.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  // The installed Google Chrome (GitHub's Ubuntu runners have it too), so no browser download.
  projects: [
    {
      name: "light",
      use: { ...devices["Desktop Chrome"], channel: "chrome", colorScheme: "light" },
    },
    { name: "dark", use: { ...devices["Desktop Chrome"], channel: "chrome", colorScheme: "dark" } },
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
