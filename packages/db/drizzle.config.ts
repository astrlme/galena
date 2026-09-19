import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  // Only `pnpm db:migrate` connects; `pnpm db:generate` reads the schema alone.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://galena:galena@localhost:5432/galena",
  },
});
