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
  })
  // The page must not share a region with the API and database, or with its replica.
  .refine(
    ({ homeRegion, pageRegions }) =>
      new Set([homeRegion, pageRegions.primary, pageRegions.replica]).size === 3,
    "homeRegion, pageRegions.primary and pageRegions.replica must all differ",
  );

export type StageConfig = z.infer<typeof stageSchema>;

// Pick a home region where your own services do not run.
const common = {
  homeRegion: "eu-central-1",
  probeRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
  pageRegions: { primary: "us-west-2", replica: "eu-north-1" },
  github: { repository: "astrlme/galena", deployRef: "refs/heads/main" },
};

export const stages = {
  dev: stageSchema.parse({ ...common, stage: "dev" }),
  prod: stageSchema.parse({ ...common, stage: "prod" }),
};

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
