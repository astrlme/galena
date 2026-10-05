import { readFileSync } from "node:fs";
import { z } from "zod";

const region = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, "not an AWS region name");
const domain = z
  .string()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a lower-case domain name, such as status.example.com");

export const stageSchema = z
  .object({
    // The deployment's name: stacks are `galena-<stage>-…`, parameters `/galena/<stage>/…`.
    stage: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,19}$/, "lower-case letters, digits and hyphens, up to 20")
      // The API treats `local` as a developer's machine: random secrets, loopback monitors.
      .refine((name) => name !== "local", "`local` is reserved for local development"),
    // API, database, queues, detection, workers' AWS access.
    homeRegion: region,
    probeRegions: z.array(region).min(3),
    pageRegions: z.object({ primary: region, replica: region }),
    // The status page's own name; its certificate is validated by a CNAME at the DNS host.
    pageDomain: domain.optional(),
    // The dashboard's own name (with the docs); its certificate is validated by a CNAME at the
    // DNS host, like the page's.
    webDomain: domain.optional(),
    // The project's own site: the landing page and the docs, without the dashboard or the API.
    // Only the maintainer's deployment sets it; a fork leaves it out.
    siteDomain: domain.optional(),
    // Where notification email comes from: an SES identity for `domain`, verified by DKIM
    // CNAMEs at the DNS host, sending as `from`.
    email: z
      .object({ domain, from: z.email() })
      .refine(
        ({ domain, from }) => from.endsWith(`@${domain}`),
        "from must be an address at domain",
      )
      .optional(),
    // Deploying from GitHub Actions through OIDC; without it there is no CI deploy role, and
    // `galena deploy` uses the caller's own AWS credentials.
    github: z
      .object({
        repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
        // The `sub` prefix in GitHub's OIDC tokens. Newer repositories use the immutable form with
        // owner and repository ids, which survives renames and can't be claimed by a lookalike
        // (`gh api repos/OWNER/REPO/actions/oidc/customization/sub` prints it).
        oidcSubject: z.string().regex(/^repo:[\w.-]+(@\d+)?\/[\w.-]+(@\d+)?$/),
        // The only Git ref whose workflows may assume the deploy role.
        deployRef: z.string().startsWith("refs/"),
      })
      .optional(),
    // DynamoDB `telemetry` capacity units. The always-free tier gives 25 read and 25 write units
    // per account and region, shared by every deployment there (`galena doctor` checks them).
    telemetryCapacity: z.object({ read: z.number().int().min(1), write: z.number().int().min(1) }),
    // Aurora Serverless v2 ceiling; the floor is 0 ACU so an idle cluster pauses.
    auroraMaxAcu: z.number().min(1).max(16),
    // The deployed smoke test (a public target the Smoke workflow stops and starts).
    smoke: z.boolean().default(false),
    // Keep buckets and the telemetry table when a stack is deleted. Aurora is always kept.
    retainData: z.boolean().default(true),
    // The trigger.dev project the workers deploy to. The stacks don't use it; the CLI does.
    triggerProjectRef: z
      .string()
      .regex(/^proj_[a-z0-9]+$/, "the project ref from trigger.dev, proj_…")
      .optional(),
  })
  // The Smoke workflow assumes its role through GitHub's OIDC.
  .refine(({ smoke, github }) => !smoke || github, "smoke needs github")
  // The page must not share a region with the API and database, or with its replica.
  .refine(
    ({ homeRegion, pageRegions }) =>
      new Set([homeRegion, pageRegions.primary, pageRegions.replica]).size === 3,
    "homeRegion, pageRegions.primary and pageRegions.replica must all differ",
  );

export type StageConfig = z.infer<typeof stageSchema>;

/** Throws when the stages sharing a home region would outgrow DynamoDB's free tier together. */
export function checkSharedFreeTier(all: readonly StageConfig[]): void {
  for (const region of new Set(all.map((s) => s.homeRegion))) {
    const here = all.filter((s) => s.homeRegion === region);
    for (const unit of ["read", "write"] as const) {
      const total = here.reduce((sum, s) => sum + s.telemetryCapacity[unit], 0);
      if (total > 25) {
        throw new Error(
          `Telemetry ${unit} capacity adds up to ${total} units in ${region}; the free tier stops at 25.`,
        );
      }
    }
  }
}

/** Every region a stage deploys to, including us-east-1 for CloudFront certificates. */
export function stageRegions(config: StageConfig): string[] {
  const { homeRegion, probeRegions, pageRegions } = config;
  return [
    ...new Set([
      homeRegion,
      ...probeRegions,
      pageRegions.primary,
      pageRegions.replica,
      "us-east-1",
    ]),
  ];
}

/** The stacks `bin/galena.ts` creates for a config, by id, in the region each deploys to. */
export function expectedStacks(config: StageConfig): { id: string; region: string }[] {
  const { stage, homeRegion, pageRegions } = config;
  const stacks: [string, string | false | undefined][] = [
    ["ci-access", config.github && homeRegion],
    ["foundation", homeRegion],
    ...config.probeRegions.map((region): [string, string] => [`probe-${region}`, region]),
    ["detection", homeRegion],
    ["smoke", config.smoke && config.github && homeRegion],
    ["api", homeRegion],
    ["dashboard-certificate", config.webDomain && "us-east-1"],
    ["web", homeRegion],
    ["site-certificate", config.siteDomain && "us-east-1"],
    ["site", config.siteDomain && homeRegion],
    ["worker-access", homeRegion],
    ["email", config.email && homeRegion],
    ["page-replica", pageRegions.replica],
    ["page-certificate", config.pageDomain && "us-east-1"],
    ["page", pageRegions.primary],
  ];
  return stacks.flatMap(([name, region]) =>
    region ? [{ id: `galena-${stage}-${name}`, region }] : [],
  );
}

/**
 * The deployment described by the JSON file at `path` (untracked: `galena init` writes it, and
 * the maintainer's Deploy workflow writes it from the `GLN_CONFIG` repository variable).
 */
export function loadConfig(path: string): StageConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No Galena config at ${path}. Run \`galena init\`, or pass -c config=<path to galena.config.json>.`,
    );
  }
  const config = stageSchema.parse(JSON.parse(text));
  checkSharedFreeTier([config]);
  return config;
}

/**
 * In GitHub Actions, refuses a config made for another repository: a fork that copied the
 * maintainer's variable would otherwise try to assume a role that doesn't trust it.
 */
export function checkRepository(config: StageConfig, env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS !== "true" || !config.github) return;
  if (env.GITHUB_REPOSITORY !== config.github.repository) {
    throw new Error(
      `This config deploys from ${config.github.repository}, not ${env.GITHUB_REPOSITORY}. Set your own github settings in galena.config.json.`,
    );
  }
}
