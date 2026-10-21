import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { createDb } from "@galena/db";
import { z } from "zod";
import { env } from "./env.ts";

/**
 * The migration to record after a run: the newest bundled one, unless the record names one this
 * bundle doesn't have. A rollback runs the previous bundle again, and the database keeps the
 * newer migration, so the record never moves back.
 */
export function pickSchemaToRecord(
  recorded: string | undefined,
  bundled: string[],
): string | undefined {
  if (recorded !== undefined && !bundled.includes(recorded)) return undefined;
  return bundled.at(-1);
}

/** Records the last migration run in SSM, outside CloudFormation, so a rollback can't undo it. */
async function recordSchema(name: string, migrations: string) {
  const { entries } = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(JSON.parse(readFileSync(`${migrations}/meta/_journal.json`, "utf8")));
  const ssm = new SSMClient({});
  const recorded = await ssm
    .send(new GetParameterCommand({ Name: name }))
    .then(({ Parameter }) => Parameter?.Value)
    .catch((error: unknown) => {
      if (error instanceof ParameterNotFound) return undefined;
      throw error;
    });
  const schema = pickSchemaToRecord(
    recorded,
    entries.map((entry) => entry.tag),
  );
  if (schema && schema !== recorded) {
    await ssm.send(
      new PutParameterCommand({ Name: name, Value: schema, Type: "String", Overwrite: true }),
    );
  }
}

// Deploy-time migrations: CDK's Trigger invokes this after the stack updates. The bundle copies
// packages/db/migrations next to it, since the source tree is not in the Lambda.
export async function handler() {
  if (!env.GLN_DB_CLUSTER_ARN || !env.GLN_DB_SECRET_ARN || !env.AWS_REGION) {
    throw new Error(
      "Migrations run against the Data API: set GLN_DB_CLUSTER_ARN and GLN_DB_SECRET_ARN.",
    );
  }
  const migrations = fileURLToPath(new URL("./migrations", import.meta.url));
  const { migrate, close } = createDb({
    kind: "data-api",
    region: env.AWS_REGION,
    resourceArn: env.GLN_DB_CLUSTER_ARN,
    secretArn: env.GLN_DB_SECRET_ARN,
    database: env.GLN_DB_NAME,
  });
  try {
    await migrate(migrations);
  } finally {
    await close();
  }
  if (env.GLN_SCHEMA_PARAM) await recordSchema(env.GLN_SCHEMA_PARAM, migrations);
}
