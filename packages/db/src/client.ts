import { fileURLToPath } from "node:url";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle as dataApiDrizzle } from "drizzle-orm/aws-data-api/pg";
import { migrate as dataApiMigrate } from "drizzle-orm/aws-data-api/pg/migrator";
import { drizzle as nodePgDrizzle } from "drizzle-orm/node-postgres";
import { migrate as nodePgMigrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { retryWhileResuming } from "./resume.ts";
import * as schema from "./schema/index.ts";

// The only place that creates a database client: node-postgres against
// local Postgres, the RDS Data API in AWS.

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbConfig =
  | { kind: "postgres"; url: string }
  | { kind: "data-api"; region: string; resourceArn: string; secretArn: string; database: string };

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

export function createDb(config: DbConfig): {
  db: Db;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
} {
  if (config.kind === "postgres") {
    const pool = new pg.Pool({ connectionString: config.url });
    const db = nodePgDrizzle(pool, { schema, casing: "snake_case" });
    return {
      db,
      migrate: () => nodePgMigrate(db, { migrationsFolder: MIGRATIONS }),
      close: () => pool.end(),
    };
  }

  const client = new RDSDataClient({ region: config.region });
  // Before serialisation, so every retry is signed afresh.
  client.middlewareStack.add((next) => (args) => retryWhileResuming(() => next(args)), {
    step: "initialize",
    name: "retryWhileAuroraResumes",
  });
  const db = dataApiDrizzle(client, {
    database: config.database,
    resourceArn: config.resourceArn,
    secretArn: config.secretArn,
    schema,
    casing: "snake_case",
  });
  return {
    db,
    migrate: () => dataApiMigrate(db, { migrationsFolder: MIGRATIONS }),
    close: async () => client.destroy(),
  };
}
