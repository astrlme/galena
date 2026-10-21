import { readFileSync } from "node:fs";
import { readReleaseVersion, releaseVersion } from "@galena/infra/config";
import { z } from "zod";

/** Where releases are published. */
export const REPOSITORY = "astrlme/galena";

/** What a deployment records: its release, and the last migration its database ran. */
export type Deployed = { version?: string | undefined; schema?: string | undefined };
/** What this checkout would deploy: its release, and the migrations it carries, oldest first. */
export type Checkout = { version: string; migrations: string[] };

/** The release and migrations of the repository this CLI runs from. */
export function readCheckout(): Checkout {
  const journal = new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url);
  const { entries } = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(JSON.parse(readFileSync(journal, "utf8")));
  return { version: readReleaseVersion(), migrations: entries.map((entry) => entry.tag) };
}

/** A release version, `major.minor.patch`. */
function parse(version: string): number[] {
  if (!releaseVersion.safeParse(version).success) {
    throw new Error(`${version} isn't a version like 1.2.3`);
  }
  return version.split(".").map(Number);
}

/** Whether `a` is a later release than `b`. */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  const at = x.findIndex((part, i) => part !== y[i]);
  return at >= 0 && (x[at] ?? 0) > (y[at] ?? 0);
}

export type DeployStep = "first" | "same" | "upgrade" | "downgrade";

/** What deploying `own` over the version a deployment recorded would be. */
export function classifyDeploy(deployed: string | undefined, own: string): DeployStep {
  if (deployed === undefined) return "first";
  if (isNewer(own, deployed)) return "upgrade";
  return isNewer(deployed, own) ? "downgrade" : "same";
}

/**
 * How deploy describes deploying `checkout` over `deployed`. Older code on a newer schema is
 * refused unless forced: migrations only move forward. Between releases `main` keeps the last
 * release's version but can carry newer migrations, so the schema is checked on its own.
 */
export function describeDeploy(deployed: Deployed, checkout: Checkout, force: boolean): string {
  const { version, schema } = deployed;
  const own = checkout.version;
  const refuse = (problem: string, forced: string) => {
    if (force) return forced;
    throw new Error(problem);
  };
  if (schema && !checkout.migrations.includes(schema)) {
    return refuse(
      `This deployment's database is at migration ${schema}, which this checkout doesn't have. Migrations only move forward, so its older code is refused: check out a release that has it, or pass --force if you know this code runs on that schema.`,
      `going back from migration ${schema}, as --force asks`,
    );
  }
  if (version !== undefined && !releaseVersion.safeParse(version).success) {
    return refuse(
      `The deployment records ${version} as its version, which isn't like 1.2.3, so this checkout can't tell whether it's older. Pass --force to deploy ${own} over it.`,
      `replacing the recorded version ${version}, as --force asks`,
    );
  }
  const notes: Record<DeployStep, () => string> = {
    first: () => "no version recorded yet",
    same: () => `already on ${own}, so this redeploys it`,
    upgrade: () => `upgrading from ${version}`,
    downgrade: () =>
      refuse(
        `This deployment runs ${version} and this checkout is ${own}. Migrations only move forward, so an older release is refused: check out v${version} or later, or pass --force if you know ${own} runs on the newer schema.`,
        `going back from ${version}, as --force asks`,
      ),
  };
  return notes[classifyDeploy(version, own)]();
}

/** The latest release's version, or undefined when GitHub can't say within 5 seconds. */
export async function fetchLatestRelease(): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const tag = z.object({ tag_name: z.string() }).parse(await response.json()).tag_name;
    const version = tag.replace(/^v/, "");
    return releaseVersion.safeParse(version).success ? version : undefined;
  } catch {
    return undefined;
  }
}
