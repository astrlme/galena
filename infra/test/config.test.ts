import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkRepository, expectedStacks, loadConfig, stageSchema } from "../config/stages.ts";
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

test("names are lower-case, `local` is reserved, and the smoke test needs GitHub", () => {
  expect(stageSchema.safeParse({ ...plain, stage: "Acme Prod" }).success).toBe(false);
  expect(stageSchema.safeParse({ ...plain, stage: "local" }).success).toBe(false);
  expect(stageSchema.safeParse({ ...plain, smoke: true }).success).toBe(false);
});

// The ids `cdk synth` prints for the fixture, and the fewest a deployment can have.
test("lists the stacks the app creates, in the regions they deploy to", () => {
  expect(expectedStacks(fixture).map(({ id }) => id)).toEqual([
    "galena-dev-ci-access",
    "galena-dev-foundation",
    "galena-dev-probe-eu-west-1",
    "galena-dev-probe-eu-west-3",
    "galena-dev-probe-eu-north-1",
    "galena-dev-detection",
    "galena-dev-smoke",
    "galena-dev-api",
    "galena-dev-dashboard-certificate",
    "galena-dev-web",
    "galena-dev-site-certificate",
    "galena-dev-site",
    "galena-dev-worker-access",
    "galena-dev-email",
    "galena-dev-page-replica",
    "galena-dev-page-certificate",
    "galena-dev-page",
  ]);
  expect(expectedStacks(plain)).toEqual([
    { id: "galena-prod-foundation", region: "eu-central-1" },
    { id: "galena-prod-probe-eu-west-1", region: "eu-west-1" },
    { id: "galena-prod-probe-eu-west-3", region: "eu-west-3" },
    { id: "galena-prod-probe-eu-north-1", region: "eu-north-1" },
    { id: "galena-prod-detection", region: "eu-central-1" },
    { id: "galena-prod-api", region: "eu-central-1" },
    { id: "galena-prod-web", region: "eu-central-1" },
    { id: "galena-prod-worker-access", region: "eu-central-1" },
    { id: "galena-prod-page-replica", region: "eu-north-1" },
    { id: "galena-prod-page", region: "eu-west-1" },
  ]);
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
