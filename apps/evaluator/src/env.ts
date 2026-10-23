import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/evaluator that reads process.env.
export const env = z
  .object({
    /** Set by Lambda: the home region, where the table, queue and config bucket live. */
    AWS_REGION: awsRegion,
    GLN_TELEMETRY_TABLE: z.string().min(1),
    GLN_CONFIG_BUCKET: z.string().min(1),
    GLN_CONFIG_KEY: z.string().min(1).default("monitors.json"),
    /** Comma-separated, e.g. `us-east-1,eu-west-1,ap-southeast-1`. */
    GLN_PROBE_REGIONS: z
      .string()
      .transform((list) => list.split(",").map((r) => r.trim()))
      .pipe(z.array(awsRegion).min(1)),
    // Where a transition starts its job. The evaluator never schedules or builds; the engine
    // takes every queue setting all the same.
    GLN_JOBS_QUEUE_URL: z.url(),
    GLN_JOBS_QUEUE_ARN: z.string().startsWith("arn:"),
    GLN_BUILDS_QUEUE_URL: z.url(),
    GLN_BUILDS_QUEUE_ARN: z.string().startsWith("arn:"),
    GLN_SCHEDULE_GROUP: z.string().min(1),
    GLN_SCHEDULER_ROLE_ARN: z.string().startsWith("arn:"),
    GLN_SCHEDULE_DEAD_LETTER_ARN: z.string().startsWith("arn:"),
    /** An optional SecureString: the ping URL of the operator's outside dead-man's switch. */
    GLN_HEARTBEAT_PARAM: z.string().startsWith("/").optional(),
  })
  .parse(process.env);
