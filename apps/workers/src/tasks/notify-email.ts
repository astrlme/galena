import { notifyEmailJob } from "../jobs/notify-email.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const notifyEmail = shim(notifyEmailJob, { queue: queues.email });
