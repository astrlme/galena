import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/api that reads process.env.
export const env = z
  .object({
    GLN_STAGE: z.enum(["local", "dev", "prod"]).default("local"),
    GLN_API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    // The origin people use: the dashboard (CloudFront in AWS, next dev locally), which also
    // serves the API on the same origin. In AWS it comes from GLN_PUBLIC_URL_PARAM instead.
    GLN_PUBLIC_URL: z.url().default("http://localhost:3000"),
    GLN_PUBLIC_URL_PARAM: z.string().startsWith("/").optional(),
    // Local: the docker-compose database. AWS: the Data API, with the cluster and its secret.
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    GLN_DB_CLUSTER_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_SECRET_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_NAME: z.string().min(1).default("galena"),
    AWS_REGION: awsRegion.optional(),
    // AWS reads the auth secret from this SecureString parameter at cold start.
    GLN_AUTH_SECRET: z.string().min(32).optional(),
    GLN_AUTH_SECRET_PARAM: z.string().startsWith("/").optional(),
    GLN_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GLN_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    // Read by the trigger.dev SDK itself; without it, changes stay in the outbox undispatched.
    TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  })
  .refine((e) => e.GLN_STAGE === "local" || e.GLN_AUTH_SECRET || e.GLN_AUTH_SECRET_PARAM, {
    message: "Outside local development, set GLN_AUTH_SECRET_PARAM (an SSM SecureString).",
    path: ["GLN_AUTH_SECRET_PARAM"],
  })
  .refine((e) => !e.GLN_DB_CLUSTER_ARN || (e.GLN_DB_SECRET_ARN && e.AWS_REGION), {
    message: "The Data API needs GLN_DB_SECRET_ARN and AWS_REGION with GLN_DB_CLUSTER_ARN.",
    path: ["GLN_DB_SECRET_ARN"],
  })
  .parse(process.env);
