import { signalIngestJob } from "../jobs/signal-ingest.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const signalIngestTask = shim(signalIngestJob, { queue: queues.signals });
