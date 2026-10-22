import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import {
  capacityCheck,
  doctor,
  formatCheck,
  nodeCheck,
  stackState,
  versionCheck,
} from "./doctor.ts";

test("Node 24 or later passes, anything older fails", () => {
  expect(nodeCheck("24.13.0").status).toBe("ok");
  expect(nodeCheck("26.0.0").status).toBe("ok");
  expect(nodeCheck("22.20.0").status).toBe("fail");
});

test("the deployment runs this CLI's version, or doctor says which way to move", () => {
  const check = (deployed: string | undefined, latest?: string, isDeployed = true) =>
    versionCheck({ own: "0.2.0", deployed, latest, isDeployed });
  expect(check("0.2.0", "0.2.0")).toEqual({
    status: "ok",
    summary: "Deployed 0.2.0, this CLI 0.2.0, latest release 0.2.0",
    details: [],
  });
  expect(check(undefined, undefined, false)).toEqual({
    status: "ok",
    summary: "Not deployed yet; this CLI deploys 0.2.0",
    details: [],
  });
  expect(check("0.1.0").details).toEqual(["galena deploy upgrades it to 0.2.0"]);
  expect(check("0.3.0").details).toEqual([
    "This CLI is older than the deployment; use v0.3.0 or later to deploy",
  ]);
  expect(check(undefined).details).toEqual([
    "Deployed before releases were recorded; galena deploy records 0.2.0",
  ]);
  expect(check("0.2.0", "0.2.1")).toEqual({
    status: "warn",
    summary: "Deployed 0.2.0, this CLI 0.2.0, latest release 0.2.1",
    details: [
      "0.2.1 is out: read its upgrade notes at https://github.com/astrlme/galena/releases/tag/v0.2.1",
    ],
  });
  expect(check("0.1.0").status).toBe("warn");
  // A version read while the stacks couldn't be still means it's deployed.
  expect(check("0.2.0", undefined, false).summary).toBe("Deployed 0.2.0, this CLI 0.2.0");
  expect(check("0.2")).toEqual({
    status: "fail",
    summary: "Deployed 0.2, this CLI 0.2.0",
    details: ["0.2 isn't a version like 1.2.3; galena deploy --force records 0.2.0"],
  });
});

test("a stack is fine once settled, worth a look while moving or after a rolled-back update", () => {
  expect(stackState("CREATE_COMPLETE")).toBe("ok");
  expect(stackState("UPDATE_COMPLETE")).toBe("ok");
  expect(stackState("UPDATE_IN_PROGRESS")).toBe("warn");
  expect(stackState("UPDATE_ROLLBACK_COMPLETE")).toBe("warn");
  expect(stackState("ROLLBACK_COMPLETE")).toBe("fail");
  expect(stackState("CREATE_FAILED")).toBe("fail");
  expect(stackState(undefined)).toBe("fail");
});

test("prints one line per check with its details indented under it", () => {
  expect(
    formatCheck({
      id: "parameters",
      status: "warn",
      summary: "3 of 3 secrets are SecureStrings under /galena/dev/",
      details: ["/galena/dev/setup-token is missing; only first-run setup needs it"],
    }),
  ).toBe(
    "warn  parameters  3 of 3 secrets are SecureStrings under /galena/dev/\n" +
      "                  /galena/dev/setup-token is missing; only first-run setup needs it\n",
  );
});

test("without a config it says how to make one, and fails", async () => {
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk;
  });
  const path = join(mkdtempSync(join(tmpdir(), "galena-doctor-")), "galena.config.json");
  expect(await doctor(path, { output })).toBe(1);
  expect(printed).toContain("galena init");
});

test("capacity past the free tier is a warning naming each table that uses some", () => {
  const tables = [
    { name: "galena-dev-telemetry", read: 5, write: 5 },
    { name: "other-app", read: 20, write: 10 },
    { name: "on-demand", read: 0, write: 0 },
  ];
  expect(capacityCheck(tables, "eu-central-1").status).toBe("ok");
  const planned = capacityCheck(tables, "eu-central-1", { read: 5, write: 5 });
  expect(planned.status).toBe("warn");
  expect(planned.summary).toContain("30 read and 20 write");
  expect(planned.summary).toContain("shared by every account in an AWS Organization");
  expect(planned.details).toEqual([
    "galena-dev-telemetry: 5 read, 5 write",
    "other-app: 20 read, 10 write",
    "telemetry (not deployed yet): 5 read, 5 write",
  ]);
});
