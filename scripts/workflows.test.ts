import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const DIR = ".github/workflows";
// Anything that installs or runs the lockfile's packages. `npx <pinned package>` is allowed: it
// fetches that one package, not the dependency tree.
const RUNS_DEPENDENCIES = /\b(pnpm|yarn|turbo)\b|\bnpm (ci|install|i|run|exec)\b|\bnode\s+\S/;

/** Jobs that can ask for GitHub's OIDC token and also run the dependency tree's code. */
function tokenJobsThatRunDependencies(workflow: string): string[] {
  const lines = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));
  const topLevel = (key: string) => {
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start < 0) return [];
    const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
    return lines.slice(start + 1, end < 0 ? undefined : end);
  };
  const workflowHasToken = topLevel("permissions").some((l) => l.includes("id-token: write"));

  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of topLevel("jobs")) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header?.[1]) {
      current = [];
      jobs.set(header[1], current);
    } else current?.push(line);
  }
  return [...jobs]
    .filter(([, body]) => {
      const ownPermissions = body.some((line) => /^ {4}permissions:/.test(line));
      const hasToken = ownPermissions
        ? body.some((line) => line.includes("id-token: write"))
        : workflowHasToken;
      return hasToken && body.some((line) => RUNS_DEPENDENCIES.test(line));
    })
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
