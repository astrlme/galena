import { Logger } from "@aws-lambda-powertools/logger";

/** One JSON line per call on stdout, which every host (trigger.dev, Lambda, local dev) keeps. */
export const log = new Logger({ serviceName: "workers" });
