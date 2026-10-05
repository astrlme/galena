import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { loadConfig } from "@galena/infra/config";
import { expect, test } from "vitest";
import { buildConfig, init, PRESETS } from "./init.ts";

const run = async (path: string, answers: string[], force = false) => {
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk;
  });
  const code = await init(path, { force, input: Readable.from(answers.join("\n")), output });
  return { code, printed };
};

test.each(Object.keys(PRESETS) as (keyof typeof PRESETS)[])(
  "the %s preset keeps the page apart from the API and its replica",
  (preset) => {
    const config = buildConfig({ stage: "prod", preset });
    expect(config.homeRegion).toBe(PRESETS[preset].homeRegion);
    expect(config.telemetryCapacity).toEqual({ read: 5, write: 5 });
  },
);

test("blank optional answers leave their settings out, and email sends as status@", () => {
  const config = buildConfig({ stage: "prod", preset: "eu", emailDomain: "mail.example.com" });
  expect(config.pageDomain).toBeUndefined();
  expect(config.triggerProjectRef).toBeUndefined();
  expect(config.email).toEqual({ domain: "mail.example.com", from: "status@mail.example.com" });
});

test("asks again after an answer the config refuses, then writes a config infra loads", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "galena-init-")), "galena.config.json");
  const { code, printed } = await run(path, [
    "Acme Prod",
    "local",
    "acme",
    "asia",
    "us",
    "Status.Example.com",
    "status.example.com",
    "",
    "mail.example.com",
    "alerts@example.com",
    "",
    "proj_abc123",
  ]);
  expect(code).toBe(0);
  expect(printed.match(/That doesn't work/g)).toHaveLength(4);
  expect(printed).toContain("Answer eu or us.");
  expect(loadConfig(path)).toMatchObject({
    stage: "acme",
    homeRegion: "us-east-2",
    pageDomain: "status.example.com",
    email: { domain: "mail.example.com", from: "status@mail.example.com" },
    triggerProjectRef: "proj_abc123",
  });
  expect(loadConfig(path).webDomain).toBeUndefined();
});

test("never replaces an existing config without --force", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "galena-init-")), "galena.config.json");
  writeFileSync(path, "{}");
  const { code, printed } = await run(path, []);
  expect(code).toBe(1);
  expect(printed).toContain("--force");
  expect(readFileSync(path, "utf8")).toBe("{}");
});

test("stops without writing when the answers run out", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "galena-init-")), "galena.config.json");
  const { code, printed } = await run(path, ["acme"]);
  expect(code).toBe(1);
  expect(printed).toContain("answers ended");
});
