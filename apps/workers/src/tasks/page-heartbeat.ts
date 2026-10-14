import { crons } from "../jobs/index.ts";
import { queues } from "./queues.ts";
import { cron } from "./shim.ts";

// On the publisher's queue, so it never stamps snapshot.json while a publish writes it.
export const pageHeartbeat = cron(crons[2], { queue: queues.publisher });
