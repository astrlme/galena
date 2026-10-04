import {
  componentId,
  incidentId,
  monitorId,
  monitorStates,
  publishPolicies,
  workspaceId,
} from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { Incident } from "../ports.ts";
import { type AutopilotMonitor, approvalOutcome, planAutopilot } from "./autopilot.ts";
import { checkUpdateBody } from "./body.ts";

const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const now = new Date("2026-10-05T10:00:00Z");
const monitor: AutopilotMonitor = {
  id: monitorId.parse("01920000-0000-7000-8000-000000000201"),
  componentId: api,
  componentName: "API",
  publishPolicy: "approve",
  downStatus: "major_outage",
};
const open: Incident = {
  id: incidentId.parse("01920000-0000-7000-8000-000000000101"),
  workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
  title: "Errors on API",
  status: "investigating",
  impact: "major",
  visibility: "published",
  source: "manual",
  startedAt: now,
  resolvedAt: null,
  updatedAt: now,
  components: [{ componentId: api, status: "partial_outage" }],
};
const plan = (over: Partial<Parameters<typeof planAutopilot>[0]> = {}) =>
  planAutopilot({ to: "down", suppressed: false, monitor, openIncidents: [], now, ...over });

describe("planAutopilot", () => {
  test("an approve monitor going down drafts an incident that waits 10 minutes", () => {
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
    expect(plan({ openIncidents: [open] })).toEqual({ action: "attach", incidentId: open.id });
  });

  test.each([
    ["inside a maintenance window", { suppressed: true }, "suppressed"],
    ["for a flapping monitor", { to: "flapping" as const }, "not_down"],
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
  ])("drafts nothing %s", (_, over, reason) => {
    expect(plan(over)).toEqual({ action: "none", reason });
  });

  test("the drafted words are ready to publish: no placeholder is left", () => {
    const drafted = plan();
    if (drafted.action !== "open") throw new Error("expected a draft");
    expect(checkUpdateBody(drafted.body).ok).toBe(true);
  });

  test("properties: only an unsuppressed down on a public, component-backed monitor opens anything", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...monitorStates),
        fc.boolean(),
        fc.constantFrom(...publishPolicies),
        fc.boolean(),
        fc.boolean(),
        (to, suppressed, publishPolicy, onComponent, covered) => {
          const m = {
            ...monitor,
            publishPolicy,
            ...(onComponent ? {} : { componentId: null, componentName: null }),
          };
          const result = plan({ to, suppressed, monitor: m, openIncidents: covered ? [open] : [] });
          const eligible =
            to === "down" && !suppressed && publishPolicy !== "internal_only" && onComponent;
          if (!eligible) return result.action === "none";
          if (covered) return result.action === "attach";
          return (
            result.action === "open" &&
            (result.visibility === "published") === (publishPolicy === "auto") &&
            (result.approvalDeadline !== null) === (publishPolicy === "approve")
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
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
