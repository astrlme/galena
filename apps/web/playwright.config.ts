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
      command: "pnpm --filter @galena/api dev",
      url: "http://localhost:8787/health",
      reuseExistingServer: !process.env.CI,
      // Fixed so sessions survive the API's watch restarts during a run; local only.
      env: { GLN_AUTH_SECRET: "e2e-only-secret-at-least-32-characters" },
    },
    {
      command: "pnpm --filter @galena/web dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
