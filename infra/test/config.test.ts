import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkRepository, loadConfig, stageSchema } from "../config/stages.ts";
import { fixture, plain } from "./fixture.ts";

test("a missing config file says how to make one", () => {
  const missing = fileURLToPath(new URL("no-such.config.json", import.meta.url));
  expect(() => loadConfig(missing)).toThrow(/galena init/);
});

test("optional settings take safe defaults: no smoke test, data kept", () => {
  expect(plain.smoke).toBe(false);
  expect(plain.retainData).toBe(true);
  expect(plain.github).toBeUndefined();
});

test("names are lower-case, and the smoke test needs GitHub", () => {
  expect(stageSchema.safeParse({ ...plain, stage: "Acme Prod" }).success).toBe(false);
  expect(stageSchema.safeParse({ ...plain, smoke: true }).success).toBe(false);
});

test("in GitHub Actions, a config made for another repository is refused", () => {
  const actions = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "someone/fork" };
  expect(() => checkRepository(fixture, actions)).toThrow(/example\/galena/);
  expect(() =>
    checkRepository(fixture, { ...actions, GITHUB_REPOSITORY: "example/galena" }),
  ).not.toThrow();
  expect(() => checkRepository(fixture, {})).not.toThrow();
  expect(() => checkRepository(plain, actions)).not.toThrow();
});
