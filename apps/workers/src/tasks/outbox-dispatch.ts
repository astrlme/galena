import { outboxDispatchJob } from "../jobs/outbox-dispatch.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const outboxDispatch = shim(outboxDispatchJob, { queue: queues.outbox });
