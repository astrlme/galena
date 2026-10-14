import { pagePublishJob } from "../jobs/page-publish.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const pagePublish = shim(pagePublishJob, { queue: queues.publisher });
