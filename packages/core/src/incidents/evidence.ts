import { type MonitorId, monitorId } from "@galena/contracts";
import { monitorDedupKey } from "./autopilot.ts";

const MINUTE = 60_000;
/** How far before the start the evidence looks, to show what normal was. */
const BEFORE_MINUTES = 30;
/** A long incident keeps this much around its start and up to its end, and leaves out the middle. */
const PART_MINUTES = 60;

type Span = { from: Date; to: Date };

/**
 * The span an incident's check results come from, and the spans actually read: one, or two
 * either side of `gap`.
 */
export type EvidenceWindow = Span & { gap: Span | null; reads: Span[] };

/**
 * From 30 minutes before the start to `end` (when it resolved, or now). An incident longer than
 * 90 minutes keeps only the hour around its start and its latest hour: a day-long one would be
 * thousands of results.
 */
export function evidenceWindow(startedAt: Date, end: Date): EvidenceWindow {
  const from = new Date(startedAt.getTime() - BEFORE_MINUTES * MINUTE);
  const part = PART_MINUTES * MINUTE;
  if (end.getTime() - from.getTime() <= 2 * part) {
    return { from, to: end, gap: null, reads: [{ from, to: end }] };
  }
  const gap = { from: new Date(from.getTime() + part), to: new Date(end.getTime() - part) };
  return {
    from,
    to: end,
    gap,
    reads: [
      { from, to: gap.from },
      { from: gap.to, to: end },
    ],
  };
}

/** The monitor that opened an incident, from the key it opened it under; null for any other. */
export function monitorOfIncident(dedupKey: string | null): MonitorId | null {
  const parsed = monitorId.safeParse(dedupKey?.split(":")[1]);
  return parsed.success && monitorDedupKey(parsed.data) === dedupKey ? parsed.data : null;
}
