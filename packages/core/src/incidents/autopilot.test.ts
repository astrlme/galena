import {
  componentId,
  type IncidentStatus,
  incidentId,
  incidentStatuses,
  monitorId,
  monitorStates,
  publishPolicies,
  workspaceId,
} from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { Incident } from "../ports.ts";
import {
  type AutopilotMonitor,
  approvalOutcome,
  monitorDedupKey,
  planAutopilot,
} from "./autopilot.ts";
import { checkUpdateBody } from "./body.ts";

const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const now = new Date("2026-10-05T10:00:00Z");
const monitor: AutopilotMonitor = {
  id: monitorId.parse("01920000-0000-7000-8000-000000000201"),
  componentId: api,
  componentName: "API",
  publishPolicy: "approve",
  downStatus: "major_outage",
  stableMinutes: 15,
};
const incident = (status: IncidentStatus, dedupKey: string | null): Incident => ({
  id: incidentId.parse(
    dedupKey ? "01920000-0000-7000-8000-000000000102" : "01920000-0000-7000-8000-000000000101",
  ),
  workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
  title: "Errors on API",
  status,
  impact: "major",
  visibility: "published",
  source: dedupKey ? "monitor" : "manual",
  startedAt: now,
  resolvedAt: null,
  updatedAt: now,
  components: [{ componentId: api, status: "partial_outage" }],
  dedupKey,
});
const manual = incident("investigating", null);
const own = (status: IncidentStatus) => incident(status, monitorDedupKey(monitor.id));
const plan = (over: Partial<Parameters<typeof planAutopilot>[0]> = {}) =>
  planAutopilot({
    from: "up",
    to: "down",
    suppressed: false,
    monitor,
    openIncidents: [],
    now,
    ...over,
  });

describe("planAutopilot: going down", () => {
  test("an approve monitor drafts an incident that waits 10 minutes", () => {
    expect(plan()).toEqual({
      action: "open",
      dedupKey: `mon:${monitor.id}`,
      visibility: "draft",
      title: "API is down",
      body: "We're seeing failed checks on API from more than one region. We're investigating and will update by 10:30 UTC.",
      impact: "major",
      components: [{ componentId: api, status: "major_outage" }],
      approvalDeadline: new Date("2026-10-05T10:10:00Z"),
    });
  });

  test("an auto monitor publishes at once, with no deadline", () => {
    expect(plan({ monitor: { ...monitor, publishPolicy: "auto" } })).toMatchObject({
      action: "open",
      visibility: "published",
      approvalDeadline: null,
    });
  });

  test("an open incident on the component takes the monitor instead of a second one", () => {
    expect(plan({ openIncidents: [manual] })).toEqual({ action: "attach", incidentId: manual.id });
    // A retried transition finds the incident it opened.
    expect(plan({ openIncidents: [manual, own("investigating")] })).toEqual({
      action: "attach",
      incidentId: own("investigating").id,
    });
  });

  test("failing again before it is stable takes its incident back to Investigating", () => {
    expect(plan({ from: "recovering", openIncidents: [own("monitoring")] })).toEqual({
      action: "update",
      incidentId: own("monitoring").id,
      expected: "monitoring",
      status: "investigating",
      body: "We're seeing failed checks on API from more than one region. We're investigating and will update by 10:30 UTC.",
    });
  });

  test("the drafted words are ready to publish: no placeholder is left", () => {
    const drafted = plan();
    if (drafted.action !== "open") throw new Error("expected a draft");
    expect(checkUpdateBody(drafted.body).ok).toBe(true);
  });
});

describe("planAutopilot: recovering", () => {
  test("recovering moves its incident to Monitoring for the stable minutes", () => {
    expect(plan({ from: "down", to: "recovering", openIncidents: [own("investigating")] })).toEqual(
      {
        action: "update",
        incidentId: own("investigating").id,
        expected: "investigating",
        status: "monitoring",
        body: "API is working normally again. We're watching it for the next 15 minutes.",
      },
    );
  });

  test("up after RECOVERING resolves it, working since recovery began", () => {
    const resolved = plan({ from: "recovering", to: "up", openIncidents: [own("monitoring")] });
    expect(resolved).toEqual({
      action: "update",
      incidentId: own("monitoring").id,
      expected: "monitoring",
      status: "resolved",
      body: "API has worked normally since 09:45 UTC. Checks pass from every region again.",
    });
    if (resolved.action !== "update") throw new Error("expected an update");
    expect(checkUpdateBody(resolved.body).ok).toBe(true);
  });

  test("up after flapping resolves it, working from now", () => {
    expect(plan({ from: "flapping", to: "up", openIncidents: [own("monitoring")] })).toMatchObject({
      status: "resolved",
      body: "API has worked normally since 10:00 UTC. Checks pass from every region again.",
    });
  });

  test("an incident someone else opened is never moved by a monitor recovering", () => {
    expect(plan({ from: "down", to: "recovering", openIncidents: [manual] })).toEqual({
      action: "none",
      reason: "no_incident",
    });
    expect(plan({ from: "recovering", to: "up", openIncidents: [manual] })).toEqual({
      action: "none",
      reason: "no_incident",
    });
  });
});

test.each([
  ["inside a maintenance window", { suppressed: true }, "suppressed"],
  ["for a flapping monitor", { from: "recovering" as const, to: "flapping" as const }, "not_down"],
  ["for a degraded monitor", { to: "degraded" as const }, "not_down"],
  [
    "for an internal-only monitor",
    { monitor: { ...monitor, publishPolicy: "internal_only" as const } },
    "internal_only",
  ],
  [
    "for a monitor on no component",
    { monitor: { ...monitor, componentId: null, componentName: null } },
    "no_component",
  ],
])("autopilot does nothing %s", (_, over, reason) => {
  expect(plan(over)).toEqual({ action: "none", reason });
});

test("properties: it opens only for an outage nothing covers, and updates only its own incident", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...monitorStates),
      fc.constantFrom(...monitorStates),
      fc.boolean(),
      fc.constantFrom(...publishPolicies),
      fc.boolean(),
      fc.option(fc.constantFrom(...incidentStatuses), { nil: undefined }),
      fc.boolean(),
      (from, to, suppressed, publishPolicy, onComponent, ownStatus, withManual) => {
        const m = {
          ...monitor,
          publishPolicy,
          ...(onComponent ? {} : { componentId: null, componentName: null }),
        };
        const open = [
          ...(withManual ? [manual] : []),
          ...(ownStatus && ownStatus !== "resolved" && ownStatus !== "postmortem"
            ? [own(ownStatus)]
            : []),
        ];
        const result = plan({ from, to, suppressed, monitor: m, openIncidents: open });
        const acts = !suppressed && publishPolicy !== "internal_only" && onComponent;
        if (!acts) return result.action === "none";
        if (result.action === "open") return to === "down" && open.length === 0;
        if (result.action === "update") {
          return (
            result.incidentId === own("investigating").id &&
            (result.status !== "resolved" || to === "up") &&
            (result.status !== "monitoring" || to === "recovering") &&
            (result.status !== "investigating" || to === "down")
          );
        }
        return true;
      },
    ),
    { numRuns: 2000 },
  );
});

describe("approvalOutcome", () => {
  test("a person's answer decides", () => {
    expect(approvalOutcome("approved", "up")).toBe("publish");
    expect(approvalOutcome("dismissed", "down")).toBe("dismiss");
  });

  test("with no answer it publishes only while the monitor is still down", () => {
    expect(approvalOutcome("timed_out", "down")).toBe("publish");
    for (const state of monitorStates.filter((s) => s !== "down")) {
      expect(approvalOutcome("timed_out", state)).toBe("dismiss");
    }
  });
});
