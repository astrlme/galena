import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/workers that reads process.env (trigger.config.ts aside). `pnpm
// trigger:dev` loads apps/workers/.env; in trigger.dev's cloud these come from the project's
// environment variables.
export const env = z
  .object({
    // Local: the docker-compose database. trigger.dev's cloud: the Data API in GLN_HOME_REGION,
    // with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY of the worker access user.
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    GLN_DB_CLUSTER_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_SECRET_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_NAME: z.string().min(1).default("galena"),
    /** Set in AWS stages: `monitors.json` goes to this bucket. Unset: to GLN_CONFIG_DIR on disk. */
    GLN_CONFIG_BUCKET: z.string().min(1).optional(),
    GLN_CONFIG_KEY: z.string().min(1).default("monitors.json"),
    GLN_HOME_REGION: awsRegion.default("eu-central-1"),
    GLN_CONFIG_DIR: z.string().min(1).default(".local/config"),
    /** Set in AWS stages: the primary page bucket. Unset: page files go to GLN_PAGE_DIR on disk. */
    GLN_PAGE_BUCKET: z.string().min(1).optional(),
    GLN_PAGE_REGION: awsRegion.default("eu-west-1"),
    GLN_PAGE_DIR: z.string().min(1).default(".local/pages"),
    /** Where readers find the page, for feed links. */
    GLN_PAGE_URL: z.url().default("http://localhost:4321"),
  })
  .refine((e) => !e.GLN_DB_CLUSTER_ARN === !e.GLN_DB_SECRET_ARN, {
    message: "The Data API needs both GLN_DB_CLUSTER_ARN and GLN_DB_SECRET_ARN.",
    path: ["GLN_DB_SECRET_ARN"],
  })
  .parse(process.env);
