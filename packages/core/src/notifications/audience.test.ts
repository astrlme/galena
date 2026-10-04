import { componentId, eventId, incidentId, maintenanceId, workspaceId } from "@galena/contracts";
import { describe, expect, test } from "vitest";
import type { Incident, IncidentUpdate, Maintenance } from "../ports.ts";
import { audience, incidentNotice, maintenanceNotice, noticeKind, notifies } from "./audience.ts";

const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const web = componentId.parse("01920000-0000-7000-8000-000000000012");
const page = { name: "Acme", url: "https://status.example.com" };
const event = eventId.parse("01920000-0000-7000-8000-000000000901");
const at = (iso: string) => new Date(iso);

describe("notifies", () => {
  test("incidents only while published", () => {
    for (const visibility of ["draft", "dismissed", "internal"] as const) {
      expect(notifies({ type: "incident.created", visibility })).toBe(false);
    }
    expect(notifies({ type: "incident.updated", visibility: "published" })).toBe(true);
  });

  test("maintenance when first scheduled, not on every edit, and when it starts, ends or is cancelled", () => {
    expect(notifies({ type: "maintenance.scheduled", version: 1 })).toBe(true);
    expect(notifies({ type: "maintenance.scheduled", version: 2 })).toBe(false);
    for (const type of [
      "maintenance.started",
      "maintenance.completed",
      "maintenance.cancelled",
    ] as const) {
      expect(notifies({ type, version: 3 })).toBe(true);
    }
  });
});

test("a target hears about its components, and everyone hears about events that name none", () => {
  const all = { id: "all", componentIds: [] };
  const apiOnly = { id: "api", componentIds: [api] };
  const webOnly = { id: "web", componentIds: [web] };
  const targets = [all, apiOnly, webOnly];
  expect(audience([api], targets).map((t) => t.id)).toEqual(["all", "api"]);
  expect(audience([api, web], targets).map((t) => t.id)).toEqual(["all", "api", "web"]);
  expect(audience([], targets).map((t) => t.id)).toEqual(["all", "api", "web"]);
});

test("a draft published later is announced as new; resolved is resolved either way", () => {
  expect(noticeKind("incident.created", false)).toBe("incident_created");
  expect(noticeKind("incident.updated", false)).toBe("incident_created");
  expect(noticeKind("incident.updated", true)).toBe("incident_updated");
  expect(noticeKind("incident.resolved", false)).toBe("incident_resolved");
  expect(noticeKind("maintenance.cancelled", true)).toBe("maintenance_cancelled");
});

test("an incident notice carries the latest update, named components and the incident's page", () => {
  const incident: Incident & { updates: IncidentUpdate[] } = {
    id: incidentId.parse("01920000-0000-7000-8000-000000000101"),
    workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
    title: "Errors on API",
    status: "identified",
    impact: "major",
    visibility: "published",
    source: "manual",
    startedAt: at("2026-09-30T10:00:00Z"),
    resolvedAt: null,
    updatedAt: at("2026-09-30T10:20:00Z"),
    components: [{ componentId: api, status: "partial_outage" }],
    updates: [
      {
        id: "u2" as never,
        status: "identified",
        body: "Rolling back.",
        createdAt: at("2026-09-30T10:20:00Z"),
      },
      {
        id: "u1" as never,
        status: "investigating",
        body: "Looking into it.",
        createdAt: at("2026-09-30T10:00:00Z"),
      },
    ],
  };
  const notice = incidentNotice({
    eventId: event,
    kind: "incident_updated",
    incident,
    names: new Map([[api, "API"]]),
    page,
    occurredAt: at("2026-09-30T10:20:05Z"),
  });
  expect(notice).toEqual({
    kind: "incident_updated",
    eventId: event,
    page,
    title: "Errors on API",
    status: "identified",
    impact: "major",
    components: [{ id: api, name: "API", status: "partial_outage" }],
    body: "Rolling back.",
    startsAt: "2026-09-30T10:00:00.000Z",
    endsAt: null,
    occurredAt: "2026-09-30T10:20:05.000Z",
    url: "https://status.example.com/incidents/01920000-0000-7000-8000-000000000101/",
  });
});

test("a notice for an earlier update carries that update's status and words, not the newest", () => {
  const incident = {
    id: incidentId.parse("01920000-0000-7000-8000-000000000101"),
    workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
    title: "Errors on API",
    status: "identified" as const,
    impact: "major" as const,
    visibility: "published" as const,
    source: "manual" as const,
    startedAt: at("2026-09-30T10:00:00Z"),
    resolvedAt: null,
    updatedAt: at("2026-09-30T10:00:20Z"),
    components: [],
    updates: [
      {
        id: "u2" as never,
        status: "identified" as const,
        body: "Rolling back.",
        createdAt: at("2026-09-30T10:00:20Z"),
      },
      {
        id: "u1" as never,
        status: "investigating" as const,
        body: "Looking into it.",
        createdAt: at("2026-09-30T10:00:00Z"),
      },
    ],
  };
  const notice = (updateId?: string) =>
    incidentNotice({
      eventId: event,
      kind: "incident_updated",
      incident,
      updateId: updateId as never,
      names: new Map(),
      page,
      occurredAt: at("2026-09-30T10:00:25Z"),
    });
  // Two updates posted seconds apart: the first event still announces the first update.
  expect(notice("u1")).toMatchObject({ status: "investigating", body: "Looking into it." });
  expect(notice("u2")).toMatchObject({ status: "identified", body: "Rolling back." });
  // Events from before updates were named announce the newest.
  expect(notice()).toMatchObject({ status: "identified", body: "Rolling back." });
});

test("a maintenance notice carries the window's times and message and links to the page", () => {
  const window: Maintenance = {
    id: maintenanceId.parse("01920000-0000-7000-8000-000000000301"),
    workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
    title: "Database upgrade",
    body: "Writes pause for up to 5 minutes.",
    status: "scheduled",
    startsAt: at("2026-10-01T22:00:00Z"),
    endsAt: at("2026-10-01T23:00:00Z"),
    version: 1,
    runId: null,
    cancelledAt: null,
    componentIds: [api, web],
  };
  expect(
    maintenanceNotice({
      eventId: event,
      kind: "maintenance_scheduled",
      window,
      names: new Map([[api, "API"]]),
      page,
      occurredAt: at("2026-09-30T09:00:00Z"),
    }),
  ).toMatchObject({
    title: "Database upgrade",
    status: "scheduled",
    impact: null,
    // A component deleted since the window was scheduled drops out.
    components: [{ id: api, name: "API", status: null }],
    body: "Writes pause for up to 5 minutes.",
    startsAt: "2026-10-01T22:00:00.000Z",
    endsAt: "2026-10-01T23:00:00.000Z",
    url: "https://status.example.com/",
  });
});
