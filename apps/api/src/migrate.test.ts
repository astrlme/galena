import { expect, test } from "vitest";
import { pickSchemaToRecord } from "./migrate.ts";

const bundled = ["0000_init", "0001_monitors", "0002_incidents"];

test("records the newest bundled migration, never moving the record back", () => {
  expect(pickSchemaToRecord(undefined, bundled)).toBe("0002_incidents");
  expect(pickSchemaToRecord("0001_monitors", bundled)).toBe("0002_incidents");
  expect(pickSchemaToRecord("0002_incidents", bundled)).toBe("0002_incidents");
  // A rollback runs the previous bundle again; the database keeps the newer migration.
  expect(pickSchemaToRecord("0003_api_keys", bundled)).toBeUndefined();
  expect(pickSchemaToRecord(undefined, [])).toBeUndefined();
});
