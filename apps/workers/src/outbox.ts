import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  eventId,
  type MonitorsFile,
  type OutboxId,
  subscriberId,
  workspaceId,
} from "@galena/contracts";
import { buildMonitorsFile, type Clock, isPageEvent } from "@galena/core";
import {
  type Db,
  findOutboxRow,
  listEnabledMonitors,
  maintenanceRepository,
  markOutboxDispatched,
  nextSnapshotVersion,
  recordDeliveries,
} from "@galena/db";
import { z } from "zod";
import { type FanoutEvent, fanoutPayload, isNotifyEvent } from "./fanout.ts";
import { type LifecycleRuns, steerMaintenance } from "./maintenance.ts";

const REWRITES_MONITORS_FILE = new Set([
  "monitor.changed",
  "maintenance.scheduled",
  "maintenance.cancelled",
]);

export type WriteMonitorsFile = (file: MonitorsFile) => Promise<void>;
export type DispatchDeps = {
  db: Db;
  clock: Clock;
  writeMonitorsFile: WriteMonitorsFile;
  runs: LifecycleRuns;
  /** Starts `page.publish` for a version taken after the change committed. */
  publish: (version: number) => Promise<void>;
  /** Starts `notify.email` with a subscriber's confirmation. */
  confirm: (request: { eventId: string; subscriberId: string }) => Promise<void>;
  /** Starts `notify.fanout` for an incident or maintenance event, keyed by its envelope id. */
  fanOut: (event: FanoutEvent) => Promise<void>;
};

const subscriberRequested = z.object({
  id: eventId,
  workspaceId,
  data: z.object({ subscriberId }),
});
export type DispatchOutcome = "rolled_back" | "already_dispatched" | "dispatched";

/**
 * Acts on one outbox row. A missing row means its transaction rolled back; a dispatched one means
 * another run got there first. Event types with no consumer yet are only marked dispatched.
 */
export async function dispatchOutbox(id: OutboxId, deps: DispatchDeps): Promise<DispatchOutcome> {
  const row = await findOutboxRow(deps.db, id);
  if (!row) return "rolled_back";
  if (row.dispatchedAt) return "already_dispatched";
  const { eventType } = row;
  if (eventType === "maintenance.scheduled" || eventType === "maintenance.cancelled") {
    await steerMaintenance(eventType, row.payload, deps);
  }
  // Monitors carry the windows covering their components, so both kinds of change rewrite it.
  if (REWRITES_MONITORS_FILE.has(eventType)) {
    const [monitors, windows] = await Promise.all([
      listEnabledMonitors(deps.db),
      maintenanceRepository(deps.db).listUnfinished(),
    ]);
    await deps.writeMonitorsFile(buildMonitorsFile(monitors, deps.clock, windows));
  }
  if (isPageEvent(eventType)) await deps.publish(await nextSnapshotVersion(deps.db));
  if (isNotifyEvent(eventType)) await deps.fanOut(fanoutPayload.parse(row.payload));
  if (eventType === "subscriber.requested") {
    const { id, workspaceId: ws, data } = subscriberRequested.parse(row.payload);
    // A delivery row like a notice's, so two runs never both send the confirmation.
    await recordDeliveries(
      deps.db,
      { workspaceId: ws, eventId: id, subjectId: data.subscriberId },
      [{ subscriberId: data.subscriberId, channel: "email" }],
    );
    await deps.confirm({ eventId: id, subscriberId: data.subscriberId });
  }
  const marked = await markOutboxDispatched(deps.db, id, deps.clock.now());
  return marked ? "dispatched" : "already_dispatched";
}

/** Local development: the file on disk, replaced whole so a reader never sees half of it. */
export function localMonitorsFile(dir: string): WriteMonitorsFile {
  const path = resolve(dir, "monitors.json");
  return async (file) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
  };
}

/** AWS stages: the private config bucket the probes and the evaluator read. */
export function s3MonitorsFile(options: {
  region: string;
  bucket: string;
  key: string;
}): WriteMonitorsFile {
  const s3 = new S3Client({ region: options.region });
  return async (file) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: options.bucket,
        Key: options.key,
        Body: JSON.stringify(file),
        ContentType: "application/json",
      }),
    );
  };
}
