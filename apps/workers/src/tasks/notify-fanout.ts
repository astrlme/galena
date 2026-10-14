import { notifyFanoutJob } from "../jobs/notify-fanout.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const notifyFanout = shim(notifyFanoutJob, { queue: queues.notify });
