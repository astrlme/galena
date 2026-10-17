import { defineConfig } from "vitest/config";

// Unit tests only: `*.test.ts` next to the source. Integration tests (`*.int.test.ts`)
// and Playwright specs (`e2e/`) have their own commands.
export const unit = defineConfig({
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.int.test.{ts,tsx}",
      "**/e2e/**",
      "test/fixtures/**",
      // The HTML builder's asset carries a copy of the status app, tests included.
      "**/cdk.out/**",
    ],
  },
});

// Integration tests (`*.int.test.ts`) start Postgres and DynamoDB Local with Testcontainers,
// so Docker must be running.
export const integration = defineConfig({
  test: {
    include: ["**/*.int.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/fixtures/**", "**/cdk.out/**"],
    testTimeout: 60_000,
    hookTimeout: 180_000, // the first run pulls the container image
  },
});
