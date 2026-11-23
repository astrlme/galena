import { monthSpan } from "@galena/core";
import type { Answer } from "../answer.ts";
import type { demoData } from "./data.ts";

/**
 * The answer to GET /v1/reports/uptime: every demo monitor and component checked all month so
 * far and never down, with no SLA targets.
 */
export function reportAnswer(
  data: ReturnType<typeof demoData>,
  month: string,
  now: Date,
): Answer<"/v1/reports/uptime"> {
  const { from, to } = monthSpan(month);
  const end = Math.min(to.getTime(), now.getTime());
  const counted = {
    minutes: Math.max(0, Math.floor((end - from.getTime()) / 60_000)),
    minutesDown: 0,
    incidents: 0,
  };
  return {
    month,
    monitors: data.monitors.monitors.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      ...counted,
      p95Ms: null,
      slaTarget: null,
      budget: null,
    })),
    components: data.components.components.map((c) => ({ id: c.id, name: c.name, ...counted })),
  };
}
