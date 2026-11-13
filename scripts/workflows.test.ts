import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const DIR = ".github/workflows";
// Anything that installs or runs the lockfile's packages. `npx <pinned package>` is allowed: it
// fetches that one package, not the dependency tree.
const RUNS_DEPENDENCIES = /\b(pnpm|yarn|turbo)\b|\bnpm (ci|install|i|run|exec)\b|\bnode\s+\S/;

/** A workflow's jobs: each one's lines, whether it can ask for the OIDC token, what it needs. */
function jobsOf(workflow: string) {
  const lines = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));
  const topLevel = (key: string) => {
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start < 0) return [];
    const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const workflowHasToken = topLevel("permissions").some((l) => l.includes("id-token: write"));

  const bodies = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of topLevel("jobs")) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header?.[1]) {
      current = [];
      bodies.set(header[1], current);
    } else current?.push(line);
  }
  return new Map(
    [...bodies].map(([name, body]) => {
      const ownPermissions = body.some((line) => /^ {4}permissions:/.test(line));
      const hasToken = ownPermissions
        ? body.some((line) => line.includes("id-token: write"))
        : workflowHasToken;
      const needs = (body.find((line) => /^ {4}needs:/.test(line)) ?? "")
        .replace(/^ {4}needs:/, "")
        .replace(/[[\]\s]/g, "")
        .split(",")
        .filter(Boolean);
      return [name, { body, hasToken, needs }] as const;
    }),
  );
}

/** Jobs that can ask for GitHub's OIDC token and also run the dependency tree's code. */
function tokenJobsThatRunDependencies(workflow: string): string[] {
  return [...jobsOf(workflow)]
    .filter(([, job]) => job.hasToken && job.body.some((line) => RUNS_DEPENDENCIES.test(line)))
    .map(([name]) => name);
}

// A job whose condition holds when a job it needs failed runs anyway.
const RUNS_AFTER_FAILURE = /^ {4}if:.*\b(always|cancelled|failure)\(\)/;

/**
 * Jobs that can ask for the OIDC token without waiting, directly or through others, for `gate`
 * to pass: no path to it through `needs`, or a condition that runs them after a failure.
 */
function tokenJobsNotAfter(workflow: string, gate: string): string[] {
  const jobs = jobsOf(workflow);
  const waitsFor = (name: string, seen: Set<string>): boolean =>
    (jobs.get(name)?.needs ?? []).some(
      (need) => need === gate || (!seen.has(need) && waitsFor(need, seen.add(need))),
    );
  const runsAnyway = (name: string, seen: Set<string>): boolean => {
    const job = jobs.get(name);
    if (!job) return false;
    if (job.body.some((line) => RUNS_AFTER_FAILURE.test(line))) return true;
    return job.needs.some((need) => !seen.has(need) && runsAnyway(need, seen.add(need)));
  };
  return [...jobs]
    .filter(
      ([name, job]) => job.hasToken && (!waitsFor(name, new Set()) || runsAnyway(name, new Set())),
    )
    .map(([name]) => name);
}

test("no job that can get the OIDC token installs or runs the dependency tree", () => {
  const offenders = readdirSync(DIR).flatMap((file) =>
    tokenJobsThatRunDependencies(readFileSync(join(DIR, file), "utf8")).map(
      (job) => `${file}: ${job}`,
    ),
  );
  expect(offenders).toEqual([]);
});

test("finds a token job that installs, through its own or the workflow's permissions", () => {
  const workflow = (permissions: string, jobPermissions: string) => `
permissions:
  contents: read
${permissions}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
  deploy:
    runs-on: ubuntu-latest
${jobPermissions}
    steps:
      - run: npx --yes aws-cdk@2.1143.0 deploy --app cdk.out
`;
  expect(tokenJobsThatRunDependencies(workflow("  id-token: write", ""))).toEqual(["build"]);
  expect(
    tokenJobsThatRunDependencies(workflow("", "    permissions:\n      id-token: write")),
  ).toEqual([]);
  expect(
    tokenJobsThatRunDependencies(
      workflow("  id-token: write", "    permissions:\n      id-token: write"),
    ),
  ).toEqual(["build"]);
});

test("Deploy reaches AWS only after CI passed on the same commit", () => {
  expect(tokenJobsNotAfter(readFileSync(join(DIR, "deploy.yml"), "utf8"), "ci")).toEqual([]);
});

test("finds a token job that doesn't wait for the gate, directly or through another job", () => {
  const workflow = (lookupsNeeds: string) => `
jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      actions: read
  lookups:
${lookupsNeeds}
    permissions:
      id-token: write
  build:
    needs: lookups
  deploy:
    needs: [build]
    permissions:
      id-token: write
`;
  expect(tokenJobsNotAfter(workflow("    needs: ci"), "ci")).toEqual([]);
  expect(tokenJobsNotAfter(workflow(""), "ci")).toEqual(["lookups", "deploy"]);
});

test("finds a token job that runs even when the gate failed", () => {
  const workflow = (condition: string) => `
jobs:
  ci:
    runs-on: ubuntu-latest
  deploy:
    needs: ci
${condition}
    permissions:
      id-token: write
`;
  expect(tokenJobsNotAfter(workflow(""), "ci")).toEqual([]);
  expect(tokenJobsNotAfter(workflow("    if: github.ref == 'refs/heads/main'"), "ci")).toEqual([]);
  expect(tokenJobsNotAfter(workflow("    if: always()"), "ci")).toEqual(["deploy"]);
  expect(tokenJobsNotAfter(workflow("    if: failure()"), "ci")).toEqual(["deploy"]);
});
