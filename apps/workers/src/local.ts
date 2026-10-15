import type { JobEngine } from "@galena/core";
import { listDrafts, maintenanceRepository } from "@galena/db";
import { draftPayloadOf } from "./autopilot.ts";
import { db } from "./db.ts";
import { setEngine } from "./engine.ts";
import { crons, jobs } from "./jobs/index.ts";
import { localEngine, startCrons } from "./local-engine.ts";
import { log } from "./log.ts";

/**
 * Every job in this process, for local development: sets the engine, starts the crons and
 * re-arms what a restart dropped. `page.rebuild-html` builds only when `html` is set: the status
 * page's dev server reads its own fixture, so the build would go unread.
 */
export async function startLocalJobs({ html }: { html: boolean }): Promise<JobEngine> {
  const local = new Map(jobs);
  const build = jobs.get("page.rebuild-html");
  if (build && !html)
    local.set("page.rebuild-html", { ...build, run: async () => ({ outcome: "skipped" }) });
  const engine = localEngine(local);
  setEngine(engine);
  startCrons(Object.values(crons), engine);
  await rearm(engine);
  return engine;
}

/** What a stopped process was holding: pending outbox rows, draft deadlines, window steps. */
async function rearm(engine: JobEngine) {
  const now = new Date();
  // The sweep takes rows pending over five minutes, so it runs again once the newest is.
  for (const at of [now, new Date(now.getTime() + 5 * 60_000)]) {
    const timestamp = at.toISOString();
    await engine.trigger(
      "outbox.sweep",
      { timestamp },
      { idempotencyKey: `boot:${timestamp}`, at },
    );
  }
  const drafts = await listDrafts(db);
  for (const draft of drafts) {
    await engine.trigger("incident.autopilot", draftPayloadOf(draft), {
      idempotencyKey: `auto:${draft.id}`,
      at: draft.approvalDeadline ?? now,
    });
  }
  const windows = await maintenanceRepository(db).listUnfinished();
  for (const window of windows) {
    const { id, workspaceId, version } = window;
    await engine.trigger(
      "maintenance.lifecycle",
      { maintenanceId: id, workspaceId, version },
      { idempotencyKey: `mnt:${id}:${version}` },
    );
  }
  log.info("local jobs started", { drafts: drafts.length, windows: windows.length });
}
