import { fileURLToPath } from "node:url";
import { createDb } from "@galena/db";
import { env } from "./env.ts";

// Deploy-time migrations: CDK's Trigger invokes this after the stack updates. The bundle copies
// packages/db/migrations next to it, since the source tree is not in the Lambda.
export async function handler() {
  if (!env.GLN_DB_CLUSTER_ARN || !env.GLN_DB_SECRET_ARN || !env.AWS_REGION) {
    throw new Error(
      "Migrations run against the Data API: set GLN_DB_CLUSTER_ARN and GLN_DB_SECRET_ARN.",
    );
  }
  const { migrate, close } = createDb({
    kind: "data-api",
    region: env.AWS_REGION,
    resourceArn: env.GLN_DB_CLUSTER_ARN,
    secretArn: env.GLN_DB_SECRET_ARN,
    database: env.GLN_DB_NAME,
  });
  try {
    await migrate(fileURLToPath(new URL("./migrations", import.meta.url)));
  } finally {
    await close();
  }
}
