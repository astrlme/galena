import { readFileSync } from "node:fs";
import {
  componentId,
  componentStatuses,
  incidentImpacts,
  incidentStatuses,
  incidentUpdateId,
  maintenanceStatuses,
  pageIndicators,
  type Snapshot,
  type SnapshotComponent,
} from "@galena/contracts";
import { describe, expect, test } from "vitest";
import { fixtureSnapshot } from "../test/fixture.ts";
import { pageFiles } from "./index.ts";

// The fixtures in test/fixtures/statuspage/ are written by hand from Statuspage's public API
// docs and what its pages serve, with made-up data.

const PATHS = [
  "status.json",
  "components.json",
  "incidents.json",
  "incidents/unresolved.json",
  "scheduled-maintenances.json",
  "scheduled-maintenances/upcoming.json",
  "scheduled-maintenances/active.json",
  "summary.json",
];

// biome-ignore lint/suspicious/noExplicitAny: test reads of published JSON
const published = (path: string, snapshot: Snapshot = fixtureSnapshot()): any =>
  JSON.parse(pageFiles(snapshot).find((f) => f.path === `api/v2/${path}`)?.body ?? "null");
const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/statuspage/${path}`, import.meta.url), "utf8"));

/** Each object's field names, keyed by where it sits: `incidents[].incident_updates[]`. */
function fields(value: unknown, path = "", out = new Map<string, Set<string>>()) {
  if (Array.isArray(value)) {
    for (const item of value) fields(item, `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    const names = Object.keys(value).sort().join(",");
    out.set(path, (out.get(path) ?? new Set()).add(names));
    for (const [key, child] of Object.entries(value))
      fields(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/** Every leaf value with where it sits: `["incidents[].impact", "major"]`. */
function values(value: unknown, path = "", out: Array<[string, unknown]> = []) {
  if (Array.isArray(value)) {
    for (const item of value) values(item, `${path}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      values(child, path ? `${path}.${key}` : key, out);
  } else {
    out.push([path, value]);
  }
  return out;
}

// What Statuspage's docs list or its pages serve. Its pages also serve `under_maintenance`, and
// `maintenance` as an impact and an indicator, which the docs leave out.
const COMPONENT = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
];
const IMPACT = ["none", "minor", "major", "critical", "maintenance"];
const INCIDENT = ["investigating", "identified", "monitoring", "resolved", "postmortem"];
const MAINTENANCE = ["scheduled", "in_progress", "verifying", "completed"];
const INDICATOR = ["none", "minor", "major", "critical", "maintenance"];
const ENUMS: Record<string, string[]> = {
  "status.indicator": INDICATOR,
  "components[].status": COMPONENT,
  "incidents[].status": INCIDENT,
  "incidents[].impact": IMPACT,
  "incidents[].incident_updates[].status": INCIDENT,
  "incidents[].components[].status": COMPONENT,
  "scheduled_maintenances[].status": MAINTENANCE,
  "scheduled_maintenances[].impact": IMPACT,
  "scheduled_maintenances[].incident_updates[].status": MAINTENANCE,
  "scheduled_maintenances[].components[].status": COMPONENT,
};

// The snapshot keeps no per-update component changes, so every `affected_components` is null,
// as Statuspage's own are on many updates.
const nullInOurs = (at: string) => at.endsWith(".affected_components[]");

describe("Statuspage v2 files", () => {
  test.each(PATHS)("%s has the same fields as Statuspage's, object by object", (path) => {
    const expected = [...fields(fixture(path))].filter(([at]) => !nullInOurs(at));
    expect(fields(published(path))).toEqual(new Map(expected));
  });

  test.each(PATHS)("%s uses only values Statuspage serves", (path) => {
    const checked = values(published(path)).filter(([at]) => at in ENUMS);
    expect(checked.length).toBeGreaterThan(0);
    for (const [at, value] of checked) expect(ENUMS[at], at).toContain(value);
  });

  test("every value Galena stores is one Statuspage serves", () => {
    expect(COMPONENT).toEqual(expect.arrayContaining([...componentStatuses]));
    expect(INCIDENT).toEqual(expect.arrayContaining([...incidentStatuses]));
    expect(IMPACT).toEqual(expect.arrayContaining([...incidentImpacts]));
    expect(MAINTENANCE).toEqual(expect.arrayContaining([...maintenanceStatuses]));
    expect(INDICATOR).toEqual(expect.arrayContaining([...pageIndicators]));
  });

  test("the summary holds unresolved incidents, then upcoming and active windows", () => {
    const summary = published("summary.json");
    expect(summary.incidents.map((i: { name: string }) => i.name)).toEqual([
      "Errors on <API> & webhooks",
    ]);
    expect(summary.scheduled_maintenances.map((m: { name: string }) => m.name)).toEqual([
      "Database upgrade",
      "CDN change",
    ]);
    expect(published("incidents.json").incidents.map((i: { name: string }) => i.name)).toEqual([
      "Errors on <API> & webhooks",
      "Slow dashboard",
    ]);
    expect(published("status.json").status).toEqual({
      indicator: "major",
      description: "Partial System Outage",
    });
  });

  test("a group takes its worst member's status, and positions count within each parent", () => {
    const snapshot = fixtureSnapshot();
    const [web, api] = snapshot.components;
    const [core] = snapshot.groups;
    if (!web || !api || !core) throw new Error("the fixture has two components and a group");
    const member = (n: string, name: string, status: SnapshotComponent["status"]) => ({
      ...api,
      id: componentId.parse(`01920000-0000-7000-8000-0000000000${n}`),
      name,
      status,
    });
    const queue = member("13", "Queue", "operational");
    const jobs = member("14", "Jobs", "degraded_performance");
    snapshot.components.push(queue, jobs);
    core.componentIds = [queue.id, api.id, jobs.id];

    const rows = published("components.json", snapshot).components.map(
      (c: { name: string; status: string; position: number; group: boolean }) =>
        `${c.position} ${c.name} ${c.status}${c.group ? " group" : ""}`,
    );
    expect(rows).toEqual([
      "1 Web under_maintenance",
      "2 Core partial_outage group",
      "1 Queue operational",
      "2 API partial_outage",
      "3 Jobs degraded_performance",
    ]);
  });

  test("times come from the records: creation from the id, monitoring from its first update", () => {
    const snapshot = fixtureSnapshot();
    const [resolved] = snapshot.incidents.recent;
    if (!resolved) throw new Error("the fixture has a resolved incident");
    const monitoring = (id: string, createdAt: string) => ({
      id: incidentUpdateId.parse(`01920000-0000-7000-8000-00000000${id}`),
      status: "monitoring" as const,
      body: "Watching it.",
      createdAt,
    });
    resolved.updates.push(
      monitoring("0204", "2026-09-27T08:30:00.000Z"),
      monitoring("0205", "2026-09-27T08:20:00.000Z"),
    );
    const [, incident] = published("incidents.json", snapshot).incidents;
    expect(incident.monitoring_at).toBe("2026-09-27T08:20:00.000Z");
    // 0x019200000000 ms, the first 48 bits of the fixture's ids.
    expect(incident.created_at).toBe("2024-09-17T12:40:52.992Z");
    expect(incident.started_at).toBe("2026-09-27T08:00:00.000Z");
    expect(incident.shortlink).toBe(`https://status.example.com/incidents/${resolved.id}/`);
  });
});
