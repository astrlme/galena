import { notifySlackJob, notifyWebhookJob } from "../jobs/notify-endpoints.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const notifySlack = shim(notifySlackJob, { queue: queues.slack });
export const notifyWebhook = shim(notifyWebhookJob, { queue: queues.webhook });
