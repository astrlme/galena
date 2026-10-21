import { expect, test } from "vitest";
import { classifyDeploy, describeDeploy, isNewer } from "./version.ts";

const checkout = { version: "0.1.0", migrations: ["0000_init", "0001_monitors"] };

test("names a deploy by the version it replaces, comparing each part as a number", () => {
  expect(classifyDeploy(undefined, "0.1.0")).toBe("first");
  expect(classifyDeploy("0.1.0", "0.1.0")).toBe("same");
  expect(classifyDeploy("0.9.0", "0.10.0")).toBe("upgrade");
  expect(classifyDeploy("0.1.1", "0.2.0")).toBe("upgrade");
  expect(classifyDeploy("1.0.0", "0.9.9")).toBe("downgrade");
  expect(classifyDeploy("0.10.0", "0.9.0")).toBe("downgrade");
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
});

test("refuses to deploy an older version over a newer one unless forced", () => {
  const deployed = { version: "0.1.0", schema: "0001_monitors" };
  const older = { ...checkout, version: "0.0.9" };
  expect(() => describeDeploy(deployed, older, false)).toThrow(
    "This deployment runs 0.1.0 and this checkout is 0.0.9.",
  );
  expect(describeDeploy(deployed, older, true)).toBe("going back from 0.1.0, as --force asks");
  expect(describeDeploy(deployed, { ...checkout, version: "0.1.1" }, false)).toBe(
    "upgrading from 0.1.0",
  );
  expect(describeDeploy(deployed, checkout, false)).toBe("already on 0.1.0, so this redeploys it");
  expect(describeDeploy({}, checkout, false)).toBe("no version recorded yet");
});

test("refuses a checkout without the migration the database is at, whatever its version", () => {
  // `main` between releases keeps the last release's version but can carry newer migrations.
  const deployed = { version: "0.1.0", schema: "0002_incidents" };
  expect(() => describeDeploy(deployed, checkout, false)).toThrow(
    "This deployment's database is at migration 0002_incidents, which this checkout doesn't have.",
  );
  expect(describeDeploy(deployed, checkout, true)).toBe(
    "going back from migration 0002_incidents, as --force asks",
  );
});

test("refuses a recorded version that isn't major.minor.patch unless forced", () => {
  expect(() => describeDeploy({ version: "0.1" }, checkout, false)).toThrow(
    "The deployment records 0.1 as its version, which isn't like 1.2.3",
  );
  expect(describeDeploy({ version: "0.1" }, checkout, true)).toBe(
    "replacing the recorded version 0.1, as --force asks",
  );
  expect(() => classifyDeploy("v0.1.0", "0.1.0")).toThrow("v0.1.0 isn't a version like 1.2.3");
  expect(() => classifyDeploy("0.1.0", "0.1.0-beta")).toThrow("0.1.0-beta isn't a version");
});
