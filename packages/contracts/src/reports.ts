import { z } from "zod";
import { monitorTypes } from "./enums.ts";
import { componentId, monitorId } from "./ids.ts";
import { month } from "./monitor-charts.ts";

const count = z.int().nonnegative();

/** What a monitor's SLA target allows its month: minutes it may spend down, and those unspent. */
export const reportBudget = z.object({
  allowedMinutes: count,
  /** Below zero once spent. */
  leftMinutes: z.int(),
});

/** One monitor's month. A minute is down when a quorum of regions failed it. */
export const reportMonitor = z.object({
  id: monitorId,
  name: z.string(),
  type: z.enum(monitorTypes),
  minutes: count,
  minutesDown: count,
  /** Opened by the monitor and started in the month: drafts and internal ones too, never dismissed. */
  incidents: count,
  /** Over every region's answers; null without any. */
  p95Ms: count.nullable(),
  slaTarget: z.number().nullable(),
  /** Null without a target. */
  budget: reportBudget.nullable(),
});

/** One component's month, by the status page's rule: partial and major outages are down. */
export const reportComponent = z.object({
  id: componentId,
  name: z.string(),
  minutes: count,
  minutesDown: count,
  /** Published incidents naming it that started in the month. */
  incidents: count,
});

/** Every monitor's and component's month. */
export const uptimeReport = z.object({
  month,
  monitors: z.array(reportMonitor),
  components: z.array(reportComponent),
});
export type UptimeReport = z.infer<typeof uptimeReport>;
