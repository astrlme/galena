import { z } from "zod";

const region = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, "not an AWS region name");

export const stageSchema = z
  .object({
    stage: z.enum(["dev", "prod"]),
    // API, database, queues, detection, workers' AWS access.
    homeRegion: region,
    probeRegions: z.array(region).min(3),
    pageRegions: z.object({ primary: region, replica: region }),
    github: z.object({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
      // The only Git ref whose workflows may assume the deploy role.
      deployRef: z.string().startsWith("refs/"),
    }),
    // DynamoDB `telemetry` capacity units. The always-free tier gives 25 read and 25 write units
    // per account and region, shared by every stage there (checked below).
    telemetryCapacity: z.object({ read: z.number().int().min(1), write: z.number().int().min(1) }),
    // Aurora Serverless v2 ceiling; the floor is 0 ACU so an idle cluster pauses.
    auroraMaxAcu: z.number().min(1).max(16),
  })
  // The page must not share a region with the API and database, or with its replica.
  .refine(
    ({ homeRegion, pageRegions }) =>
      new Set([homeRegion, pageRegions.primary, pageRegions.replica]).size === 3,
    "homeRegion, pageRegions.primary and pageRegions.replica must all differ",
  );

export type StageConfig = z.infer<typeof stageSchema>;

// Defaults for a deployment whose people and servers are in Europe: the API and database in
// Frankfurt, probes in three other EU regions, and the status page in Ireland with a Stockholm
// replica. Pick a home region where your own services do not run.
const common = {
  homeRegion: "eu-central-1",
  probeRegions: ["eu-west-1", "eu-west-3", "eu-north-1"],
  pageRegions: { primary: "eu-west-1", replica: "eu-north-1" },
  github: { repository: "astrlme/galena", deployRef: "refs/heads/main" },
};

export const stages = {
  dev: stageSchema.parse({
    ...common,
    stage: "dev",
    telemetryCapacity: { read: 5, write: 5 },
    auroraMaxAcu: 2,
  }),
  prod: stageSchema.parse({
    ...common,
    stage: "prod",
    telemetryCapacity: { read: 20, write: 20 },
    auroraMaxAcu: 4,
  }),
};

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
checkSharedFreeTier(Object.values(stages));

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

export function stageConfig(name: unknown): StageConfig {
  if (name === "dev" || name === "prod") return stages[name];
  throw new Error(`Unknown stage ${JSON.stringify(name)}. Pass -c stage=dev or -c stage=prod.`);
}
