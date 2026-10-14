import { monitorStateChangedJob } from "../jobs/monitor-state-changed.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const monitorStateChanged = shim(monitorStateChangedJob, { queue: queues.incidents });
