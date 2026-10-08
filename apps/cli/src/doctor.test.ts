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
  requiredTriggerEnv,
  stackState,
} from "./doctor.ts";
import { buildConfig } from "./init.ts";

test("Node 24 or later passes, anything older fails", () => {
  expect(nodeCheck("24.13.0").status).toBe("ok");
  expect(nodeCheck("26.0.0").status).toBe("ok");
  expect(nodeCheck("22.20.0").status).toBe("fail");
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

test("the workers need the email variables only when the deployment sends email", () => {
  const quiet = buildConfig({ stage: "prod", preset: "eu" });
  const mail = buildConfig({ stage: "prod", preset: "eu", emailDomain: "mail.example.com" });
  expect(requiredTriggerEnv(quiet)).toContain("GLN_TELEMETRY_TABLE");
  expect(requiredTriggerEnv(quiet)).not.toContain("GLN_EMAIL_FROM");
  expect(requiredTriggerEnv(mail)).toEqual(
    expect.arrayContaining(["GLN_EMAIL_FROM", "GLN_SES_CONFIGURATION_SET"]),
  );
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
