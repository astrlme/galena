import type { Job } from "../runner.ts";
import { incidentAutopilotJob } from "./incident-autopilot.ts";
import { maintenanceLifecycleJob } from "./maintenance-lifecycle.ts";
import { monitorStateChangedJob } from "./monitor-state-changed.ts";
import { notifyEmailJob } from "./notify-email.ts";
import { notifySlackJob, notifyWebhookJob } from "./notify-endpoints.ts";
import { notifyFanoutJob } from "./notify-fanout.ts";
import { outboxDispatchJob } from "./outbox-dispatch.ts";
import { outboxSweepJob } from "./outbox-sweep.ts";
import { pageHeartbeatJob } from "./page-heartbeat.ts";
import { pagePublishJob } from "./page-publish.ts";
import { pageRebuildHtmlJob } from "./page-rebuild-html.ts";
import { rollupUptimeJob } from "./rollup-uptime.ts";
import { signalIngestJob } from "./signal-ingest.ts";
import { slackApprovalCardJob, slackCommandJob, slackInteractionJob } from "./slack.ts";

/**
 * Every job, by name, for engines that run them themselves. Each engine parses a payload with
 * the job's own schema before running it, so the payload types can be erased here.
 */
export const jobs: ReadonlyMap<string, Job<unknown>> = new Map(
  [
    incidentAutopilotJob,
    maintenanceLifecycleJob,
    monitorStateChangedJob,
    notifyEmailJob,
    notifySlackJob,
    notifyWebhookJob,
    notifyFanoutJob,
    outboxDispatchJob,
    outboxSweepJob,
    pageHeartbeatJob,
    pagePublishJob,
    pageRebuildHtmlJob,
    rollupUptimeJob,
    signalIngestJob,
    slackApprovalCardJob,
    slackCommandJob,
    slackInteractionJob,
  ].map((job) => [job.name, job as unknown as Job<unknown>]),
);

/**
 * The scheduled jobs, in cron syntax (UTC). The sweep and the rollup share a minute so Aurora
 * wakes once; each wake costs about ten minutes of capacity.
 */
export const crons = [
  { job: outboxSweepJob, pattern: "5 */6 * * *" },
  { job: rollupUptimeJob, pattern: "5 */6 * * *" },
  { job: pageHeartbeatJob, pattern: "35 * * * *" },
] as const;
