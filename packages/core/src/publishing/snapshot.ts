import type {
  ComponentId,
  ComponentStatus,
  DownStatus,
  MonitorState,
  Snapshot,
  SnapshotDay,
  SnapshotIncident,
  SnapshotMaintenance,
} from "@galena/contracts";
import type {
  Clock,
  Component,
  ComponentGroup,
  Incident,
  IncidentUpdate,
  Maintenance,
} from "../ports.ts";
import { componentStatus, isOpenPublished, pageIndicator } from "../status/aggregate.ts";
import { dayMark } from "./uptime.ts";

const DAY = 86_400_000;
const STRIP_DAYS = 90;
const RECENT_DAYS = 14;

/** One day of one component's rollup: minutes spent in each status (UTC date). */
export type UptimeDay = {
  componentId: ComponentId;
  date: string;
  minutes: Partial<Record<ComponentStatus, number>>;
};

/** Everything the page shows, as loaded from the database. */
export type SnapshotInputs = {
  snapshotVersion: number;
  page: { slug: string; name: string; url: string };
  /** In page order. */
  groups: readonly ComponentGroup[];
  /** In page order. */
  components: readonly Component[];
  /** Each monitor's current confirmed state. */
  monitors: ReadonlyArray<{
    componentId: ComponentId | null;
    state: MonitorState;
    downStatus: DownStatus;
    enabled: boolean;
  }>;
  /** Open incidents and those resolved recently, of any visibility: filtered here. */
  incidents: ReadonlyArray<Incident & { updates: IncidentUpdate[] }>;
  /** Unfinished windows, and completed ones: filtered here. */
  maintenance: readonly Maintenance[];
  uptime: readonly UptimeDay[];
};

const toIncident = (i: Incident & { updates: IncidentUpdate[] }): SnapshotIncident => ({
  id: i.id,
  title: i.title,
  status: i.status,
  impact: i.impact,
  startedAt: i.startedAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
  updatedAt: i.updatedAt.toISOString(),
  components: i.components,
  updates: i.updates.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
});

const toMaintenance = (m: Maintenance): SnapshotMaintenance => ({
  id: m.id,
  title: m.title,
  body: m.body,
  status: m.status,
  startsAt: m.startsAt.toISOString(),
  endsAt: m.endsAt.toISOString(),
  componentIds: m.componentIds,
});

const PAGE_EVENT_PREFIXES = [
  "incident.",
  "maintenance.",
  "component.",
  "component_group.",
  "monitor.",
];

/** Whether an outbox event can change what a status page shows, so the page republishes. */
export function isPageEvent(type: string): boolean {
  return PAGE_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** The last 90 UTC dates, oldest first, ending with `now`'s date. */
function stripDates(now: Date): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: STRIP_DAYS }, (_, k) =>
    new Date(today - (STRIP_DAYS - 1 - k) * DAY).toISOString().slice(0, 10),
  );
}

/** The page's read model. Pure: every published file derives from what this returns. */
export function buildSnapshot(inputs: SnapshotInputs, clock: Clock): Snapshot {
  const now = clock.now();
  const running = (m: Maintenance) => m.status === "in_progress" || m.status === "verifying";
  const dates = stripDates(now);

  const components = inputs.components.map((component) => {
    const status = componentStatus({
      current: component.status,
      monitors: inputs.monitors.filter((m) => m.enabled && m.componentId === component.id),
      incidents: inputs.incidents.flatMap((i) =>
        i.components
          .filter((c) => c.componentId === component.id)
          .map((c) => ({ status: i.status, visibility: i.visibility, componentStatus: c.status })),
      ),
      inMaintenance: inputs.maintenance.some(
        (m) => running(m) && m.componentIds.includes(component.id),
      ),
      manualStatus: component.manualStatus,
    });
    const rows = new Map(
      inputs.uptime.filter((u) => u.componentId === component.id).map((u) => [u.date, u.minutes]),
    );
    const days = dates.map((date): SnapshotDay => ({ date, ...dayMark(rows.get(date) ?? {}) }));
    let observed = 0;
    let down = 0;
    for (const date of dates) {
      const minutes = rows.get(date);
      if (!minutes) continue;
      observed += Object.values(minutes).reduce((sum, m) => sum + m, 0);
      down += dayMark(minutes).downMinutes;
    }
    return {
      id: component.id,
      groupId: component.groupId,
      name: component.name,
      description: component.description,
      status,
      days,
      uptime: observed > 0 ? Math.round(((observed - down) / observed) * 10_000) / 100 : null,
    };
  });

  const published = inputs.incidents.filter((i) => i.visibility === "published");
  const recentSince = now.getTime() - RECENT_DAYS * DAY;
  return {
    version: 1,
    snapshotVersion: inputs.snapshotVersion,
    publishedAt: now.toISOString(),
    page: inputs.page,
    indicator: pageIndicator(
      components.map((c) => c.status),
      inputs.incidents,
    ),
    groups: inputs.groups.map((g) => ({
      id: g.id,
      name: g.name,
      componentIds: components.filter((c) => c.groupId === g.id).map((c) => c.id),
    })),
    components,
    incidents: {
      active: published
        .filter(isOpenPublished)
        .toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .map(toIncident),
      recent: published
        .filter((i) => i.resolvedAt !== null && i.resolvedAt.getTime() >= recentSince)
        .toSorted((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))
        .map(toIncident),
    },
    maintenance: {
      active: inputs.maintenance.filter(running).map(toMaintenance),
      upcoming: inputs.maintenance
        .filter((m) => m.status === "scheduled" && m.cancelledAt === null)
        .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map(toMaintenance),
    },
  };
}
