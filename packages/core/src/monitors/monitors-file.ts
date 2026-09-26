import type { MonitorConfig, MonitorsFile } from "@galena/contracts";
import type { Clock } from "../ports.ts";

/**
 * The contents of `monitors.json`: enabled monitors only, sorted by id so that the same
 * monitors always produce the same list, and only the fields probes and the evaluator read.
 */
export function buildMonitorsFile(monitors: readonly MonitorConfig[], clock: Clock): MonitorsFile {
  return {
    version: 1,
    generatedAt: clock.now().toISOString(),
    monitors: monitors
      .filter((m) => m.enabled)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map(({ id, workspaceId, type, http, downStatus, detection }) => ({
        id,
        workspaceId,
        type,
        http,
        downStatus,
        detection,
      })),
  };
}
