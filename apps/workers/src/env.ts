import { fileURLToPath } from "node:url";
import { awsRegion } from "@galena/contracts";
import { LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { z } from "zod";

/** A folder under apps/workers/.local, wherever the process started. */
const local = (folder: string) => fileURLToPath(new URL(`../.local/${folder}`, import.meta.url));

// The only place in apps/workers that reads settings from process.env (`astroBuild` only passes
// the path and temp folders through): locally the dev process's environment, on Lambda the
// function's.
export const env = z
  .object({
    // Local: the docker-compose database. On Lambda: the Data API in GLN_HOME_REGION.
    GLN_DATABASE_URL: z.string().default("postgres://galena:galena@localhost:5432/galena"),
    GLN_DB_CLUSTER_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_SECRET_ARN: z.string().startsWith("arn:").optional(),
    GLN_DB_NAME: z.string().min(1).default("galena"),
    /** Set in AWS stages: `monitors.json` goes to this bucket. Unset: to GLN_CONFIG_DIR on disk. */
    GLN_CONFIG_BUCKET: z.string().min(1).optional(),
    GLN_CONFIG_KEY: z.string().min(1).default("monitors.json"),
    GLN_HOME_REGION: awsRegion.default("eu-central-1"),
    GLN_CONFIG_DIR: z.string().min(1).default(local("config")),
    /** Set in AWS stages: the primary page bucket. Unset: page files go to GLN_PAGE_DIR on disk. */
    GLN_PAGE_BUCKET: z.string().min(1).optional(),
    GLN_PAGE_REGION: awsRegion.default("eu-west-1"),
    GLN_PAGE_DIR: z.string().min(1).default(local("pages")),
    /** Where readers find the page, for feed links. */
    GLN_PAGE_URL: z.url().default("http://localhost:4321"),
    /** The dashboard's origin, for links from Slack messages. */
    GLN_DASHBOARD_URL: z.url().default("http://localhost:3000"),
    /** The app key (32 bytes, base64) the API also holds: signs links, seals credentials. */
    GLN_APP_KEY: z.string().min(1).optional(),
    /** Set in AWS stages: email goes through SES from this address. Unset: to GLN_MAIL_DIR. */
    GLN_EMAIL_FROM: z.email().optional(),
    GLN_SES_CONFIGURATION_SET: z.string().min(1).default("galena-dev"),
    GLN_MAIL_DIR: z.string().min(1).default(local("mail")),
    /** The table the evaluator writes monitor states to. Locally DynamoDB Local's `telemetry`. */
    GLN_TELEMETRY_TABLE: z.string().min(1).default("telemetry"),
    GLN_DYNAMODB_ENDPOINT: z.url().optional(),
  })
  .refine((e) => !e.GLN_DB_CLUSTER_ARN === !e.GLN_DB_SECRET_ARN, {
    message: "The Data API needs both GLN_DB_CLUSTER_ARN and GLN_DB_SECRET_ARN.",
    path: ["GLN_DB_SECRET_ARN"],
  })
  .parse(process.env);

let hostAppKey: string | undefined;

/** On Lambda the host reads the app key from SSM at cold start, before any job module loads. */
export function setAppKey(key: string) {
  hostAppKey = key;
}

/**
 * The app key (32 bytes, base64) the API also holds: signs links, seals credentials. Locally the
 * development key; a deployment that reaches the Data API must have its own.
 */
export function appKey(): string {
  const key = hostAppKey ?? env.GLN_APP_KEY;
  if (key) return key;
  if (env.GLN_DB_CLUSTER_ARN) {
    throw new Error(
      "Workers reaching the Data API need GLN_APP_KEY, the same app key the API reads.",
    );
  }
  return LOCAL_APP_KEY;
}

let hostHeartbeatUrl: string | undefined;

/**
 * On Lambda the host reads the ping URL of the operator's outside dead-man's switch from SSM at
 * cold start, when the deployment has one. Locally nothing pings.
 */
export function setHeartbeatUrl(url: string | undefined) {
  hostHeartbeatUrl = url;
}

export function heartbeatUrl(): string | undefined {
  return hostHeartbeatUrl;
}

const arn = z.string().startsWith("arn:");

/** What a job function on Lambda reads besides the above: its queue, and where failures go. */
export const queueEnv = () =>
  z.object({ GLN_QUEUE_URL: z.url(), GLN_DEAD_LETTER_URL: z.url() }).parse(process.env);

/** What the jobs function also reads, to start other jobs and to fetch the app key. */
export const engineEnv = () =>
  z
    .object({
      GLN_APP_KEY_PARAM: z.string().startsWith("/"),
      GLN_HEARTBEAT_PARAM: z.string().startsWith("/").optional(),
      GLN_JOBS_QUEUE_URL: z.url(),
      GLN_JOBS_QUEUE_ARN: arn,
      GLN_BUILDS_QUEUE_URL: z.url(),
      GLN_BUILDS_QUEUE_ARN: arn,
      GLN_SCHEDULE_GROUP: z.string().min(1),
      GLN_SCHEDULER_ROLE_ARN: arn,
      GLN_SCHEDULE_DEAD_LETTER_ARN: arn,
    })
    .parse(process.env);
