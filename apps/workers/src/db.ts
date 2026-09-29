import { createDb } from "@galena/db";
import { env } from "./env.ts";

/** The workers' database: local Postgres, or Aurora through the Data API in trigger.dev's cloud. */
export const { db } = createDb(
  env.GLN_DB_CLUSTER_ARN && env.GLN_DB_SECRET_ARN
    ? {
        kind: "data-api",
        region: env.GLN_HOME_REGION,
        resourceArn: env.GLN_DB_CLUSTER_ARN,
        secretArn: env.GLN_DB_SECRET_ARN,
        database: env.GLN_DB_NAME,
      }
    : { kind: "postgres", url: env.GLN_DATABASE_URL },
);
