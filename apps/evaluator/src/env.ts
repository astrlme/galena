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
    /** The SecureString holding the trigger.dev secret key, read at cold start. */
    GLN_TRIGGER_SECRET_PARAM: z.string().startsWith("/"),
  })
  .parse(process.env);
