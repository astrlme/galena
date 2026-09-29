import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import * as schema from "./index.ts";

// Schema conventions, checked for every table in the schema.
// Keys are camelCase here; the client and drizzle-kit write them as snake_case.
const IDENTITY_TABLES = ["user", "session", "account", "verification", "two_factor"];
// Drizzle's concrete table types don't narrow to PgTable under exactOptionalPropertyTypes.
const tables = Object.values(schema).flatMap((value) =>
  is(value, PgTable) ? [getTableConfig(value as unknown as PgTable)] : [],
);

describe.each(tables.map((t) => [t.name, t] as const))("%s", (name, table) => {
  const columns = table.columns.map((c) => c.name);

  test("has id, created_at and updated_at", () => {
    expect(columns).toEqual(expect.arrayContaining(["id", "createdAt", "updatedAt"]));
  });

  test("carries workspace_id unless it is an identity table or the workspace itself", () => {
    const exempt = IDENTITY_TABLES.includes(name) || name === "workspace";
    expect(columns.includes("workspaceId")).toBe(!exempt);
  });

  test("indexes every foreign key", () => {
    const leading = table.indexes.map((i) => (i.config.columns[0] as { name: string }).name);
    for (const fk of table.foreignKeys) {
      const column = fk.reference().columns[0]?.name;
      expect(leading, `${name}.${column} has no index`).toContain(column);
    }
  });
});

test("the schema has exactly the expected tables", () => {
  expect(tables.map((t) => t.name).sort()).toEqual(
    [
      "account",
      "audit_log",
      "component",
      "component_group",
      "incident",
      "incident_component",
      "incident_update",
      "maintenance",
      "maintenance_component",
      "member",
      "monitor",
      "outbox",
      "page",
      "page_component",
      "session",
      "timeline_event",
      "two_factor",
      "user",
      "verification",
      "workspace",
    ].sort(),
  );
});
