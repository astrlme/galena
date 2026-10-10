import { monitorId, snapshot } from "@galena/contracts";
import { type Clock, type HeartbeatPlan, planHeartbeat } from "@galena/core";
import type { NoteFile, PageStore } from "./publishing.ts";
import type { ReadStates } from "./states.ts";

export type HeartbeatDeps = {
  clock: Clock;
  store: PageStore;
  note: NoteFile;
  readStates: ReadStates;
  /** Catches monitor states up and publishes: the one path here that reads the database. */
  rollup: () => Promise<unknown>;
};

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Confirms the published page from S3 and DynamoDB alone when it shows every state detection
 * holds, by stamping `snapshot.json` with the time; otherwise runs the rollup, which reads the
 * database and publishes again.
 */
export async function beat(deps: HeartbeatDeps): Promise<HeartbeatPlan> {
  const note = await deps.note.read();
  const raw = note ? parse(await deps.store.read(note.slug, "snapshot.json")) : undefined;
  const page = snapshot.safeParse(raw);
  const ids = note ? Object.keys(note.monitors).map((id) => monitorId.parse(id)) : [];
  const now = deps.clock.now();
  const plan = planHeartbeat({
    snapshotVersion: page.success ? page.data.snapshotVersion : undefined,
    published: note,
    detected: ids.length > 0 ? await deps.readStates(ids) : new Map(),
    now,
  });
  if (plan.action === "confirm" && note && raw !== undefined) {
    // Only the time changes; every other byte is what the publish wrote.
    const confirmed = { ...(raw as object), publishedAt: now.toISOString() };
    await deps.store.write(note.slug, [
      {
        path: "snapshot.json",
        body: `${JSON.stringify(confirmed)}\n`,
        contentType: "application/json",
      },
    ]);
  }
  if (plan.action === "rollup") await deps.rollup();
  return plan;
}
