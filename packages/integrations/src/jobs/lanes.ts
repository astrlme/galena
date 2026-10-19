import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Jobs that run one at a time across the deployment. */
const serial: Record<string, string> = {
  // Each run rebuilds monitors.json, so the newest committed state is written last.
  "outbox.dispatch": "outbox",
  // Each publish reads the database after the one before it wrote; the heartbeat never stamps
  // snapshot.json while a publish writes it.
  "page.publish": "publisher",
  "page.heartbeat": "publisher",
  "page.rebuild-html": "builder",
  // A group's firing and resolve messages never race.
  "signal.ingest": "signals",
  // Scheduled every six hours: a fixed lane gives their recurring schedules a fixed group.
  "outbox.sweep": "sweep",
  "rollup.uptime": "rollup",
};

/** SES's send rate allows a few emails at once. */
const EMAIL_LANES = 5;

/**
 * The lane a job runs in: jobs in one lane run one at a time, in order; lanes run side by side.
 * Every input comes from the job's idempotency key, so any engine computes the same lane.
 */
export function laneOf(job: string, key: string): string {
  const fixed = serial[job];
  if (fixed) return fixed;
  const parts = key.split(":");
  switch (job) {
    case "monitor.state-changed":
      // `mon:{monitorId}:{transitionSeq}`: one monitor's transitions in order.
      return `mon:${parts[1]}`;
    case "notify.slack":
    case "notify.webhook":
      // `send:{eventId}:{endpointId}`, a retry `…:{attempt}`: one send at a time per destination.
      return `${job.slice("notify.".length)}:${parts[2]}`;
    case "notify.email":
      // `send:{eventId}:{subscriberId}`.
      return `email:${Number.parseInt(sha256(parts[2] ?? "").slice(0, 8), 16) % EMAIL_LANES}`;
    default:
      return sha256(key);
  }
}
