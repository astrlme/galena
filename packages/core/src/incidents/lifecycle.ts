import type { IncidentStatus } from "@galena/contracts";
import type { Clock, IncidentStage } from "../ports.ts";
import { err, ok, type Result } from "../result.ts";

// The incident lifecycle. Staying in the same status is always allowed: that is another update
// on the same stage, such as a fresh ETA while still investigating.
const MOVES: Record<IncidentStatus, readonly IncidentStatus[]> = {
  investigating: ["identified", "monitoring", "resolved"],
  identified: ["monitoring", "resolved"],
  monitoring: ["investigating", "resolved"], // the problem came back
  resolved: ["postmortem"],
  postmortem: [],
};

export function canMoveTo(from: IncidentStatus, to: IncidentStatus): boolean {
  return from === to || MOVES[from].includes(to);
}

/** The statuses the next update may have, the current one first. */
export function nextStatuses(from: IncidentStatus): IncidentStatus[] {
  return [from, ...MOVES[from]];
}

export type IncidentStep = IncidentStage & {
  /** A timeline entry is due. */
  statusChanged: boolean;
  event: "incident.updated" | "incident.resolved";
};

const closes = (status: IncidentStatus) => status === "resolved" || status === "postmortem";

/** A new incident may open in any status but postmortem, including resolved (a backfilled one). */
export function startIncident(
  status: IncidentStatus,
  clock: Clock,
): Result<IncidentStage, "illegal_transition"> {
  if (status === "postmortem") {
    return err("illegal_transition", "A new incident can't start as a postmortem.");
  }
  return ok({ status, resolvedAt: closes(status) ? clock.now() : null });
}

/** The incident after one more update, or why the update can't move it there. */
export function applyUpdate(
  current: IncidentStage,
  to: IncidentStatus,
  clock: Clock,
): Result<IncidentStep, "illegal_transition"> {
  if (!canMoveTo(current.status, to)) {
    const allowed = MOVES[current.status];
    return err(
      "illegal_transition",
      allowed.length === 0
        ? `A ${current.status} incident can't move to another status.`
        : `A ${current.status} incident can move to ${allowed.join(" or ")} only.`,
    );
  }
  const entersResolved = to === "resolved" && current.status !== "resolved";
  return ok({
    status: to,
    // Kept from the first resolution through a postmortem.
    resolvedAt: entersResolved ? clock.now() : current.resolvedAt,
    statusChanged: to !== current.status,
    event: entersResolved ? "incident.resolved" : "incident.updated",
  });
}
