import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/workers that reads process.env (trigger.config.ts aside). `pnpm
// trigger:dev` loads apps/workers/.env; in trigger.dev's cloud these come from the project's
// environment variables.
export const env = z
  .object({
    // Known limit: local Postgres only; runs in trigger.dev's cloud need the Data API connection.
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    /** Set in AWS stages: `monitors.json` goes to this bucket. Unset: to GLN_CONFIG_DIR on disk. */
    GLN_CONFIG_BUCKET: z.string().min(1).optional(),
    GLN_CONFIG_KEY: z.string().min(1).default("monitors.json"),
    GLN_HOME_REGION: awsRegion.default("eu-central-1"),
    GLN_CONFIG_DIR: z.string().min(1).default(".local/config"),
  })
  .parse(process.env);
