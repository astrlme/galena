import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/api that reads process.env.
export const env = z
  .object({
    // `local`, or the deployment's name in AWS. Only `local` changes behaviour.
    GLN_STAGE: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,19}$/)
      .default("local"),
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
    // Telemetry the evaluator writes. Locally DynamoDB Local from docker-compose.
    GLN_TELEMETRY_TABLE: z.string().min(1).default("telemetry"),
    GLN_DYNAMODB_ENDPOINT: z.url().optional(),
    /** Comma-separated; the dashboard shows one latency column per region. */
    GLN_PROBE_REGIONS: z
      .string()
      .default("eu-west-1,eu-west-3,eu-north-1")
      .transform((list) => list.split(",").map((r) => r.trim()))
      .pipe(z.array(awsRegion).min(1)),
    // Local only: monitors may target 127.0.0.1 (see targets.ts). Ignored in every other stage.
    GLN_ALLOW_LOOPBACK: z.stringbool().default(false),
    GLN_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GLN_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    // The trigger.dev secret key: from the env locally, from this SecureString in AWS. Without
    // it, changes stay in the outbox undispatched.
    TRIGGER_SECRET_KEY: z.string().min(1).optional(),
    // 32 random bytes, base64: seals stored credentials and signs subscription links. From the
    // env or this SecureString; local development falls back to a fixed development key.
    GLN_APP_KEY: z.string().min(1).optional(),
    GLN_APP_KEY_PARAM: z.string().startsWith("/").optional(),
    GLN_TRIGGER_SECRET_PARAM: z.string().startsWith("/").optional(),
    // AWS: the address notification email comes from. Without it the deployment sends no email,
    // so the status page takes no subscriptions.
    GLN_EMAIL_FROM: z.email().optional(),
    // The Slack app's client id, client secret and signing secret as JSON: from the env locally,
    // from this SecureString in AWS. Without either, Slack is off.
    GLN_SLACK_APP: z.string().min(1).optional(),
    GLN_SLACK_APP_PARAM: z.string().startsWith("/").optional(),
    // AWS: the SecureString first-run setup must be sent; setup is refused until it exists.
    GLN_SETUP_TOKEN_PARAM: z.string().startsWith("/").optional(),
    // AWS: the secret CloudFront adds to every request it forwards, read through SSM's
    // /aws/reference/secretsmanager/ path. Unset locally, where nothing checks it.
    GLN_ORIGIN_SECRET_PARAM: z.string().startsWith("/aws/reference/secretsmanager/").optional(),
  })
  .refine((e) => !e.GLN_DB_CLUSTER_ARN || (e.GLN_DB_SECRET_ARN && e.AWS_REGION), {
    message: "The Data API needs GLN_DB_SECRET_ARN and AWS_REGION with GLN_DB_CLUSTER_ARN.",
    path: ["GLN_DB_SECRET_ARN"],
  })
  .parse(process.env);
