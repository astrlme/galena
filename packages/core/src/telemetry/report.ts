import type {
  ComponentId,
  ComponentStatus,
  MonitorId,
  MonitorType,
  UptimeReport,
} from "@galena/contracts";
import { componentMinutes } from "../publishing/uptime.ts";
import { type MinuteCounts, mergeMinutes, type RegionRollup } from "./rollup.ts";
import { monthSpan, totalOf } from "./series.ts";

/** A monitor's month as a report reads it. */
export type MonthOf = { minutes: number; minutesDown: number; p95Ms: number | null };

/**
 * A monitor's month from its daily rollups (and today's hours while the month is running): the
 * minutes checked and down, and one p95 over every region's answers, merged before the quantile.
 */
export function monthOf(spans: { minutes: MinuteCounts[]; regions: RegionRollup[] }): MonthOf {
  const { minutes, down } = spans.minutes.reduce(mergeMinutes, { minutes: 0, down: 0 });
  return { minutes, minutesDown: down, p95Ms: totalOf(spans.regions)?.p95Ms ?? null };
}

/** What an SLA target allows a month: minutes it may spend down, and those still unspent. */
export type ErrorBudget = { allowedMinutes: number; leftMinutes: number };

/**
 * `target` (a percentage, to a thousandth) of the minutes checked so far plus `minutesLeft`, the
 * month's minutes still to come. A finished month has none left, so its budget holds exactly
 * when its uptime meets the target; a running one says how much more down time it can take.
 * Below zero once spent.
 */
export function errorBudget(month: MinuteCounts, target: number, minutesLeft: number): ErrorBudget {
  // In thousandths of a percent, so 99.9% of 1,000 minutes allows one, not 0.99999.
  const missable = 100_000 - Math.round(target * 1000);
  const allowedMinutes = Math.floor((missable * (month.minutes + minutesLeft)) / 100_000);
  return { allowedMinutes, leftMinutes: allowedMinutes - month.down };
}

/** Whole minutes of `month` (`YYYY-MM`) still to come at `now`: none once it is over. */
export function minutesLeftIn(month: string, now: Date): number {
  const { from, to } = monthSpan(month);
  const start = Math.max(from.getTime(), now.getTime());
  return Math.max(0, Math.floor((to.getTime() - start) / 60_000));
}

/** What a month's report is made of. */
export type ReportInputs = {
  month: string;
  /** Each with its month as telemetry counted it. */
  monitors: ReadonlyArray<{
    id: MonitorId;
    name: string;
    type: MonitorType;
    enabled: boolean;
    slaTarget: number | null;
    counted: MonthOf;
  }>;
  components: ReadonlyArray<{ id: ComponentId; name: string }>;
  /** The month's rows from the uptime rollup. */
  days: ReadonlyArray<{
    componentId: ComponentId;
    minutes: Partial<Record<ComponentStatus, number>>;
  }>;
  /** Incidents that started in the month, by the monitor that opened them and by component. */
  incidents: {
    monitors: ReadonlyMap<MonitorId, number>;
    components: ReadonlyMap<ComponentId, number>;
  };
};

/**
 * Every monitor's and component's month. A paused monitor's budget counts no minutes still to
 * come, since nothing will check them.
 */
export function uptimeReport(inputs: ReportInputs, now: Date): UptimeReport {
  const left = minutesLeftIn(inputs.month, now);
  const daysOf = Map.groupBy(inputs.days, (d) => d.componentId);
  return {
    month: inputs.month,
    monitors: inputs.monitors.map(({ id, name, type, enabled, slaTarget, counted }) => ({
      id,
      name,
      type,
      ...counted,
      incidents: inputs.incidents.monitors.get(id) ?? 0,
      slaTarget,
      budget:
        slaTarget === null
          ? null
          : errorBudget(
              { minutes: counted.minutes, down: counted.minutesDown },
              slaTarget,
              enabled ? left : 0,
            ),
    })),
    components: inputs.components.map(({ id, name }) => {
      const { minutes, down } = componentMinutes((daysOf.get(id) ?? []).map((d) => d.minutes));
      return {
        id,
        name,
        minutes: Math.round(minutes),
        minutesDown: down,
        incidents: inputs.incidents.components.get(id) ?? 0,
      };
    }),
  };
}
