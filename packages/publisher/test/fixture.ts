import {
  componentGroupId,
  componentId,
  incidentId,
  incidentUpdateId,
  maintenanceId,
  workspaceId,
} from "@galena/contracts";
import { buildSnapshot, fixedClock, type SnapshotInputs } from "@galena/core";

// A small workspace with one of everything the page shows. The golden files are built from it.

const ws = workspaceId.parse("01920000-0000-7000-8000-000000000001");
const core = componentGroupId.parse("01920000-0000-7000-8000-000000000031");
const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const web = componentId.parse("01920000-0000-7000-8000-000000000012");
export const NOW = "2026-09-29T12:00:00.000Z";
const at = (iso: string) => new Date(iso);

export const inputs: SnapshotInputs = {
  snapshotVersion: 7,
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
      description: "Public REST API",
      position: 1,
      status: "operational",
      manualStatus: null,
    },
  ],
  monitors: [{ componentId: api, state: "down", downStatus: "partial_outage", enabled: true }],
  incidents: [
    {
      id: incidentId.parse("01920000-0000-7000-8000-000000000101"),
      workspaceId: ws,
      title: "Errors on <API> & webhooks",
      status: "identified",
      impact: "major",
      visibility: "published",
      source: "manual",
      startedAt: at("2026-09-29T10:02:00.000Z"),
      resolvedAt: null,
      updatedAt: at("2026-09-29T10:20:00.000Z"),
      components: [{ componentId: api, status: "partial_outage" }],
      updates: [
        {
          id: incidentUpdateId.parse("01920000-0000-7000-8000-000000000202"),
          status: "identified",
          body: "We found the cause: a bad deploy. We're rolling it back.",
          createdAt: at("2026-09-29T10:20:00.000Z"),
        },
        {
          id: incidentUpdateId.parse("01920000-0000-7000-8000-000000000201"),
          status: "investigating",
          body: "We're seeing errors on API from 3 regions.",
          createdAt: at("2026-09-29T10:02:00.000Z"),
        },
      ],
    },
    {
      id: incidentId.parse("01920000-0000-7000-8000-000000000102"),
      workspaceId: ws,
      title: "Slow dashboard",
      status: "resolved",
      impact: "minor",
      visibility: "published",
      source: "manual",
      startedAt: at("2026-09-27T08:00:00.000Z"),
      resolvedAt: at("2026-09-27T08:40:00.000Z"),
      updatedAt: at("2026-09-27T08:40:00.000Z"),
      components: [{ componentId: web, status: "degraded_performance" }],
      updates: [
        {
          id: incidentUpdateId.parse("01920000-0000-7000-8000-000000000203"),
          status: "resolved",
          body: "Web has worked normally since 08:40 UTC.",
          createdAt: at("2026-09-27T08:40:00.000Z"),
        },
      ],
    },
  ],
  maintenance: [
    {
      id: maintenanceId.parse("01920000-0000-7000-8000-000000000301"),
      workspaceId: ws,
      title: "Database upgrade",
      body: "Writes pause for up to 5 minutes.",
      status: "scheduled",
      startsAt: at("2026-09-30T22:00:00.000Z"),
      endsAt: at("2026-09-30T23:00:00.000Z"),
      version: 1,
      runId: null,
      cancelledAt: null,
      componentIds: [api],
    },
  ],
  uptime: [
    { componentId: api, date: "2026-09-27", minutes: { operational: 1440 } },
    { componentId: api, date: "2026-09-28", minutes: { operational: 1380, major_outage: 60 } },
    { componentId: api, date: "2026-09-29", minutes: { operational: 600, partial_outage: 120 } },
    {
      componentId: web,
      date: "2026-09-27",
      minutes: { operational: 1400, degraded_performance: 40 },
    },
  ],
};

export const fixtureSnapshot = () => buildSnapshot(inputs, fixedClock(NOW));
