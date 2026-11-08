import { cronPatterns } from "@galena/integrations/jobs";
import type { Job } from "../runner.ts";
import { expiryScanJob } from "./expiry-scan.ts";
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
import { rollupTelemetryJob } from "./rollup-telemetry.ts";
import { rollupUptimeJob } from "./rollup-uptime.ts";
import { signalIngestJob } from "./signal-ingest.ts";
import { slackApprovalCardJob, slackCommandJob, slackInteractionJob } from "./slack.ts";

/**
 * Every job, by name, for engines that run them themselves. Each engine parses a payload with
 * the job's own schema before running it, so the payload types can be erased here.
 */
export const jobs: ReadonlyMap<string, Job<unknown>> = new Map(
  [
    expiryScanJob,
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
    rollupTelemetryJob,
    rollupUptimeJob,
    signalIngestJob,
    slackApprovalCardJob,
    slackCommandJob,
    slackInteractionJob,
  ].map((job) => [job.name, job as unknown as Job<unknown>]),
);

/** The scheduled jobs, with the patterns every engine uses. */
export const crons = {
  outboxSweep: { job: outboxSweepJob, pattern: cronPatterns["outbox.sweep"] },
  rollupUptime: { job: rollupUptimeJob, pattern: cronPatterns["rollup.uptime"] },
  pageHeartbeat: { job: pageHeartbeatJob, pattern: cronPatterns["page.heartbeat"] },
  rollupTelemetry: { job: rollupTelemetryJob, pattern: cronPatterns["rollup.telemetry"] },
  expiryScan: { job: expiryScanJob, pattern: cronPatterns["expiry.scan"] },
};
