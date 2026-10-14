import { slackApprovalCardJob, slackCommandJob, slackInteractionJob } from "../jobs/slack.ts";
import { queues } from "./queues.ts";
import { shim } from "./shim.ts";

export const slackApprovalCard = shim(slackApprovalCardJob, { queue: queues.slackApp });
export const slackInteraction = shim(slackInteractionJob, { queue: queues.slackApp });
export const slackCommand = shim(slackCommandJob, { queue: queues.slackApp });
