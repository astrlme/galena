import { defineConfig } from "vitest/config";

// Unit tests only: `*.test.ts` next to the source. Integration tests (`*.int.test.ts`)
// and Playwright specs (`e2e/`) have their own commands.
export const unit = defineConfig({
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.{ts,tsx}", "**/e2e/**"],
  },
});
