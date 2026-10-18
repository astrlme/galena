import type {
  ComponentStatus,
  PageIndicator,
  Snapshot,
  SnapshotComponent,
  SnapshotIncident,
  SnapshotMaintenance,
} from "@galena/contracts";

// Statuspage's public v2 files (`/api/v2/*.json`), so tools and widgets made for Statuspage read
// a Galena page unchanged: the same field names and values, snake_case.

// Statuspage's own wording for each indicator.
const DESCRIPTIONS: Record<PageIndicator, string> = {
  none: "All Systems Operational",
  minor: "Minor Service Outage",
  major: "Partial System Outage",
  critical: "Major Service Outage",
};

// Least to most severe: a group shows its worst member, as Statuspage's groups do.
const SEVERITY: readonly ComponentStatus[] = [
  "operational",
  "under_maintenance",
  "degraded_performance",
  "partial_outage",
  "major_outage",
];
const worst = (statuses: readonly ComponentStatus[]) =>
  statuses.reduce<ComponentStatus>(
    (a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a),
    "operational",
  );

/** Ids are UUIDv7: the first 48 bits are the creation time in milliseconds. */
const createdAt = (id: string) =>
  new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString();

const json = (body: unknown) => `${JSON.stringify(body)}\n`;

/** The `/api/v2` files for a snapshot, paths relative to the page's root. */
export function statuspageFiles(s: Snapshot): Array<{ path: string; body: string }> {
  const page = {
    id: s.page.slug,
    name: s.page.name,
    url: s.page.url.replace(/\/$/, ""),
    time_zone: "Etc/UTC",
    updated_at: s.publishedAt,
  };
  const status = { indicator: s.indicator, description: DESCRIPTIONS[s.indicator] };

  // The snapshot keeps no time of a component's last change, so `updated_at` is the publish.
  const leaf = (c: SnapshotComponent, position: number) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    created_at: createdAt(c.id),
    updated_at: s.publishedAt,
    position,
    description: c.description,
    showcase: true,
    start_date: c.days.find((d) => d.worst !== null)?.date ?? null,
    group_id: c.groupId,
    page_id: page.id,
    group: false,
    only_show_if_degraded: false,
  });
  // Positions count from 1 within each parent: the page, or a group.
  const byId = new Map(s.components.map((c) => [c.id, c]));
  const top = s.components.filter((c) => c.groupId === null);
  const components = [
    ...top.map((c, i) => leaf(c, i + 1)),
    ...s.groups.flatMap((g, i) => {
      const members = g.componentIds.flatMap((id) => byId.get(id) ?? []);
      return [
        {
          id: g.id,
          name: g.name,
          status: worst(members.map((m) => m.status)),
          created_at: createdAt(g.id),
          updated_at: s.publishedAt,
          position: top.length + i + 1,
          description: null,
          showcase: false,
          start_date: null,
          group_id: null,
          page_id: page.id,
          group: true,
          only_show_if_degraded: false,
          components: members.map((m) => m.id),
        },
        ...members.map((m, j) => leaf(m, j + 1)),
      ];
    }),
  ];

  // Incidents and windows carry their components' current state, as Statuspage's do.
  const leaves = new Map<string, unknown>(components.filter((c) => !c.group).map((c) => [c.id, c]));
  const current = (ids: readonly string[]) => ids.flatMap((id) => leaves.get(id) ?? []);
  const update = (
    parent: string,
    u: { id: string; status: string; body: string; createdAt: string },
  ) => ({
    id: u.id,
    status: u.status,
    body: u.body,
    incident_id: parent,
    created_at: u.createdAt,
    updated_at: u.createdAt,
    display_at: u.createdAt,
    affected_components: null,
    deliver_notifications: true,
    custom_tweet: null,
    tweet_id: null,
  });
  const incident = (i: SnapshotIncident) => ({
    id: i.id,
    name: i.title,
    status: i.status,
    created_at: createdAt(i.id),
    updated_at: i.updatedAt,
    // Updates are newest first, so the last match is the first `monitoring` update.
    monitoring_at: i.updates.findLast((u) => u.status === "monitoring")?.createdAt ?? null,
    resolved_at: i.resolvedAt,
    impact: i.impact,
    shortlink: `${page.url}/incidents/${i.id}/`,
    started_at: i.startedAt,
    page_id: page.id,
    incident_updates: i.updates.map((u) => update(i.id, u)),
    components: current(i.components.map((c) => c.componentId)),
    reminder_intervals: null,
  });
  const unresolved = s.incidents.active.map(incident);
  // Known limit: the snapshot holds 14 days of resolved incidents, where Statuspage lists the
  // last 50 whatever their age. Older ones need the snapshot to carry them.
  const incidents = [...unresolved, ...s.incidents.recent.map(incident)].slice(0, 50);

  const maintenance = (m: SnapshotMaintenance) => ({
    id: m.id,
    name: m.title,
    status: m.status,
    created_at: createdAt(m.id),
    updated_at: s.publishedAt,
    monitoring_at: null,
    resolved_at: null,
    impact: "maintenance",
    shortlink: `${page.url}/`,
    // Statuspage's `started_at` on a window is when it was written, not when it starts.
    started_at: createdAt(m.id),
    page_id: page.id,
    // A window keeps its message, not a history: one update, from when it was scheduled.
    incident_updates: [
      update(m.id, { id: m.id, status: "scheduled", body: m.body, createdAt: createdAt(m.id) }),
    ],
    components: current(m.componentIds),
    scheduled_for: m.startsAt,
    scheduled_until: m.endsAt,
  });
  const upcoming = s.maintenance.upcoming.map(maintenance);
  const active = s.maintenance.active.map(maintenance);
  // Known limit: completed windows leave the snapshot, so this lists only upcoming and active
  // ones, where Statuspage adds completed ones up to 50. The snapshot would need to carry them.
  const windows = [...upcoming, ...active];

  return [
    {
      path: "summary.json",
      body: json({
        page,
        components,
        incidents: unresolved,
        scheduled_maintenances: windows,
        status,
      }),
    },
    { path: "status.json", body: json({ page, status }) },
    { path: "components.json", body: json({ page, components }) },
    { path: "incidents.json", body: json({ page, incidents }) },
    { path: "incidents/unresolved.json", body: json({ page, incidents: unresolved }) },
    { path: "scheduled-maintenances.json", body: json({ page, scheduled_maintenances: windows }) },
    {
      path: "scheduled-maintenances/upcoming.json",
      body: json({ page, scheduled_maintenances: upcoming }),
    },
    {
      path: "scheduled-maintenances/active.json",
      body: json({ page, scheduled_maintenances: active }),
    },
  ];
}
