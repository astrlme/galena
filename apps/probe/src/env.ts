import { awsRegion } from "@galena/contracts";
import { z } from "zod";

// The only place in apps/probe that reads process.env.
export const env = z
  .object({
    /** Set by Lambda: the probe region this copy runs in. */
    AWS_REGION: awsRegion,
    /** Where the config bucket and the results queue live. */
    GLN_HOME_REGION: awsRegion,
    GLN_CONFIG_BUCKET: z.string().min(1),
    GLN_CONFIG_KEY: z.string().min(1).default("monitors.json"),
    GLN_QUEUE_URL: z.url(),
    GLN_CANARY_URL: z.url().default("https://checkip.amazonaws.com/"),
  })
  .parse(process.env);
