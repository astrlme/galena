import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { doctor, formatCheck, nodeCheck, stackState } from "./doctor.ts";

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
