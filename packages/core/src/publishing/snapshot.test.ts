import {
  componentGroupId,
  componentId,
  incidentId,
  incidentUpdateId,
  maintenanceId,
  snapshot,
  workspaceId,
} from "@galena/contracts";
import { expect, test } from "vitest";
import { fixedClock, type Incident, type IncidentUpdate, type Maintenance } from "../ports.ts";
import { buildSnapshot, isPageEvent, type SnapshotInputs } from "./snapshot.ts";

const ws = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const core = componentGroupId.parse("01920000-0000-7000-8000-000000000031");
const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const web = componentId.parse("01920000-0000-7000-8000-000000000012");
const NOW = "2026-09-29T12:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000);

let ids = 0;
const incident = (overrides: Partial<Incident>): Incident & { updates: IncidentUpdate[] } => {
  ids++;
  return {
    id: incidentId.parse(`01920000-0000-7000-8000-0000000001${String(ids).padStart(2, "0")}`),
    workspaceId: ws,
    title: `Incident ${ids}`,
    status: "investigating",
    impact: "minor",
    visibility: "published",
    source: "manual",
    startedAt: daysAgo(0.1),
    resolvedAt: null,
    updatedAt: daysAgo(0.1),
    components: [],
    updates: [
      {
        id: incidentUpdateId.parse(
          `01920000-0000-7000-8000-0000000002${String(ids).padStart(2, "0")}`,
        ),
        status: overrides.status ?? "investigating",
        body: "What happened.",
        createdAt: daysAgo(0.1),
      },
    ],
    ...overrides,
  };
};
const window = (n: number, overrides: Partial<Maintenance>): Maintenance => ({
  id: maintenanceId.parse(`01920000-0000-7000-8000-00000000030${n}`),
  workspaceId: ws,
  title: `Window ${n}`,
  body: "Planned work.",
  status: "scheduled",
  startsAt: daysAgo(-1),
  endsAt: daysAgo(-1.1),
  version: 1,
  runId: null,
  cancelledAt: null,
  componentIds: [web],
  ...overrides,
});

const inputs: SnapshotInputs = {
  snapshotVersion: 42,
  page: { slug: "acme", name: "Acme", url: "https://status.example.com" },
  groups: [{ id: core, workspaceId: ws, name: "Core", position: 0 }],
  components: [
    {
      id: web,
      workspaceId: ws,
      groupId: null,
      name: "Web",
      description: null,
      position: 0,
      status: "operational",
      manualStatus: null,
    },
    {
      id: api,
      workspaceId: ws,
      groupId: core,
      name: "API",
      description: "Public API",
      position: 1,
      status: "operational",
      manualStatus: null,
    },
  ],
  monitors: [
    { componentId: api, state: "down", downStatus: "partial_outage", enabled: true },
    { componentId: web, state: "down", downStatus: "major_outage", enabled: false },
  ],
  incidents: [
    incident({ impact: "major", components: [{ componentId: api, status: "major_outage" }] }),
    incident({ visibility: "draft", impact: "critical" }),
    incident({ status: "resolved", resolvedAt: daysAgo(3), startedAt: daysAgo(3.1) }),
    incident({ status: "resolved", resolvedAt: daysAgo(20), startedAt: daysAgo(20.1) }),
    incident({ visibility: "internal", status: "resolved", resolvedAt: daysAgo(2) }),
  ],
  maintenance: [
    window(1, { status: "in_progress", startsAt: daysAgo(0.05), endsAt: daysAgo(-0.05) }),
    window(2, {}),
    window(3, { status: "completed", cancelledAt: daysAgo(1) }),
  ],
  uptime: [
    { componentId: api, date: "2026-09-28", minutes: { operational: 1380, partial_outage: 60 } },
    { componentId: api, date: "2026-09-29", minutes: { operational: 720 } },
  ],
};

test("builds a valid snapshot of what is public right now", () => {
  const built = buildSnapshot(inputs, fixedClock(NOW));
  expect(snapshot.parse(built)).toEqual(built);
  expect(built).toMatchObject({
    version: 1,
    snapshotVersion: 42,
    publishedAt: NOW,
    indicator: "critical",
  });

  const [first, second] = built.components;
  // The monitor says partial outage, the open incident says major: the worst wins.
  expect(second).toMatchObject({ id: api, status: "major_outage" });
  // A disabled monitor has no say; the running window puts Web under maintenance.
  expect(first).toMatchObject({ id: web, status: "under_maintenance", uptime: null });
  expect(built.groups).toEqual([{ id: core, name: "Core", componentIds: [api] }]);
});

test("draws 90 days, ending today, from the daily rollups", () => {
  const api = buildSnapshot(inputs, fixedClock(NOW)).components[1];
  expect(api?.days).toHaveLength(90);
  expect(api?.days.at(0)).toEqual({ date: "2026-07-02", worst: null, downMinutes: 0 });
  expect(api?.days.slice(-2)).toEqual([
    { date: "2026-09-28", worst: "partial_outage", downMinutes: 60 },
    { date: "2026-09-29", worst: "operational", downMinutes: 0 },
  ]);
  // 60 minutes down out of 2160 observed.
  expect(api?.uptime).toBe(97.22);
});

test("lists only published incidents, and resolved ones from the last 14 days", () => {
  const { incidents, maintenance } = buildSnapshot(inputs, fixedClock(NOW));
  expect(incidents.active.map((i) => i.title)).toEqual(["Incident 1"]);
  expect(incidents.recent.map((i) => i.title)).toEqual(["Incident 3"]);
  expect(maintenance.active.map((m) => m.title)).toEqual(["Window 1"]);
  expect(maintenance.upcoming.map((m) => m.title)).toEqual(["Window 2"]);
});

test("incident, maintenance, component and monitor events republish the page; others do not", () => {
  for (const type of [
    "incident.updated",
    "maintenance.started",
    "component.changed",
    "component_group.changed",
    "monitor.changed",
  ]) {
    expect(isPageEvent(type), type).toBe(true);
  }
  for (const type of ["subscriber.confirmed", "webhook_endpoint.changed", "incidents"]) {
    expect(isPageEvent(type), type).toBe(false);
  }
});
