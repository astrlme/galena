import type { MonitorConfig, MonitorsFile } from "@galena/contracts";
import type { Clock } from "../ports.ts";

/** A maintenance window that hasn't completed, with the components it covers. */
export type ComponentWindow = { componentIds: readonly string[]; startsAt: Date; endsAt: Date };

/**
 * The contents of `monitors.json`: enabled monitors only, sorted by id so that the same
 * monitors always produce the same list, and only the fields probes and the evaluator read.
 * Each monitor carries the windows that cover its component.
 */
export function buildMonitorsFile(
  monitors: readonly MonitorConfig[],
  clock: Clock,
  windows: readonly ComponentWindow[] = [],
): MonitorsFile {
  return {
    version: 1,
    generatedAt: clock.now().toISOString(),
    monitors: monitors
      .filter((m) => m.enabled)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(({ id, workspaceId, componentId, type, http, downStatus, detection }) => ({
        id,
        workspaceId,
        type,
        http,
        downStatus,
        detection,
        maintenance: windows
          .filter((w) => componentId !== null && w.componentIds.includes(componentId))
          .map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
      })),
  };
}
