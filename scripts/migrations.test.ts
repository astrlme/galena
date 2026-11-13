import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const DIR = "packages/db/migrations";
// Applied before this rule: 0013 and 0016 drop what earlier releases had stopped using.
const FIRST_CHECKED = 19;
// A migration that removes or reshapes something says so on its first line, naming the release
// that stopped using it: `-- galena: contract (unused since 1.2.0)`.
const CONTRACT = /^-- galena: contract\b/;

// During a deploy the previous release's API and jobs keep running against the new schema until
// their own stacks update, so a migration may only add. Each of these can break that code.
const BREAKING: [RegExp, string][] = [
  [/\bdrop\s+(table|column|type|view)\b/i, "drops"],
  [/\balter\s+column\s+"?\w+"?\s+(set\s+data\s+)?type\b/i, "changes a column's type"],
  [/\brename\b/i, "renames"],
  [/\bset\s+not\s+null\b/i, "makes a column required"],
  [
    /\badd\s+column\b(?![^;]*\bdefault\b)[^;]*\bnot\s+null\b/i,
    "adds a required column without a default",
  ],
];

/** What in a migration could break the release before it; nothing for a marked contract step. */
function breaking(sql: string): string[] {
  if (CONTRACT.test(sql)) return [];
  const statements = sql.replace(/--.*$/gm, "");
  return BREAKING.filter(([pattern]) => pattern.test(statements)).map(([, why]) => why);
}

test("every new migration works with the release before it, or says it is a contract step", () => {
  const offenders = readdirSync(DIR)
    .filter((file) => file.endsWith(".sql") && Number.parseInt(file, 10) >= FIRST_CHECKED)
    .flatMap((file) => {
      const why = breaking(readFileSync(join(DIR, file), "utf8"));
      return why.length ? [`${file}: ${why.join(", ")}`] : [];
    });
  expect(offenders).toEqual([]);
});

test("names what would break the release before it", () => {
  expect(breaking('ALTER TABLE "monitor" DROP COLUMN "kind";')).toEqual(["drops"]);
  expect(breaking('ALTER TABLE "monitor" ALTER COLUMN "name" SET DATA TYPE varchar(80);')).toEqual([
    "changes a column's type",
  ]);
  expect(breaking('ALTER TABLE "monitor" RENAME COLUMN "name" TO "title";')).toEqual(["renames"]);
  expect(breaking('ALTER TABLE "monitor" ALTER COLUMN "name" SET NOT NULL;')).toEqual([
    "makes a column required",
  ]);
  expect(breaking('ALTER TABLE "monitor" ADD COLUMN "note" text NOT NULL;')).toEqual([
    "adds a required column without a default",
  ]);
  // The rule would have caught the ones applied before it.
  expect(breaking(readFileSync(join(DIR, "0016_drop_rate_limit.sql"), "utf8"))).toEqual(["drops"]);
});

test("lets through what only adds, and a marked contract step", () => {
  expect(breaking('CREATE TABLE "note" ("id" uuid PRIMARY KEY NOT NULL);')).toEqual([]);
  expect(breaking('ALTER TABLE "monitor" ADD COLUMN "note" text DEFAULT \'\' NOT NULL;')).toEqual(
    [],
  );
  expect(breaking('ALTER TABLE "monitor" ADD COLUMN "note" text;')).toEqual([]);
  expect(breaking("-- dropping is fine to mention in a comment\nSELECT 1;")).toEqual([]);
  expect(
    breaking('-- galena: contract (unused since 1.2.0)\nALTER TABLE "monitor" DROP COLUMN "kind";'),
  ).toEqual([]);
});
