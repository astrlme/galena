import {
  type ComponentStatus,
  componentStatuses,
  type IncidentImpact,
  incidentImpacts,
  incidentStatuses,
  incidentVisibilities,
  type MonitorState,
  monitorStates,
  type PageIndicator,
  pageIndicators,
} from "@galena/contracts";
import { describe, expect, test } from "vitest";
import { componentStatus, type DownStatus, pageIndicator } from "./aggregate.ts";

const monitor = (state: MonitorState, downStatus: DownStatus = "major_outage") => ({
  state,
  downStatus,
});
const component = (
  monitors: ReturnType<typeof monitor>[],
  current: ComponentStatus = "operational",
) => componentStatus({ current, monitors, inMaintenance: false, manualStatus: null });

describe("component status", () => {
  // Mapping monitor state to component status, one row each.
  test.each([
    ["up", "major_outage", "operational"],
    ["degraded", "major_outage", "degraded_performance"],
    ["down", "major_outage", "major_outage"],
    ["down", "partial_outage", "partial_outage"],
    ["recovering", "major_outage", "operational"],
    ["flapping", "major_outage", "degraded_performance"],
  ] as const)("maps a %s monitor (downStatus %s) to %s", (state, downStatus, expected) => {
    expect(component([monitor(state, downStatus)], "under_maintenance")).toBe(expected);
  });

  test.each(componentStatuses)("keeps %s while every monitor is unknown", (current) => {
    expect(component([monitor("unknown"), monitor("unknown")], current)).toBe(current);
    expect(component([], current)).toBe(current);
  });

  test("shows the worst status among several monitors, ignoring unknown ones", () => {
    expect(component([monitor("up"), monitor("degraded"), monitor("unknown")])).toBe(
      "degraded_performance",
    );
    expect(component([monitor("down", "partial_outage"), monitor("down", "major_outage")])).toBe(
      "major_outage",
    );
  });

  test("the worst of any two monitors does not depend on their order", () => {
    const variants = monitorStates.flatMap((s) =>
      (["partial_outage", "major_outage"] as const).map((d) => monitor(s, d)),
    );
    for (const a of variants) {
      for (const b of variants) expect(component([a, b])).toBe(component([b, a]));
    }
  });

  test("an active maintenance window overrides every monitor", () => {
    expect(
      componentStatus({
        current: "operational",
        monitors: [monitor("down")],
        inMaintenance: true,
        manualStatus: null,
      }),
    ).toBe("under_maintenance");
  });

  test.each(componentStatuses)("a manual %s wins over maintenance and monitors", (manual) => {
    expect(
      componentStatus({
        current: "operational",
        monitors: [monitor("down")],
        inMaintenance: true,
        manualStatus: manual,
      }),
    ).toBe(manual);
  });
});

describe("page indicator", () => {
  const byComponent: Record<ComponentStatus, PageIndicator> = {
    operational: "none",
    under_maintenance: "none",
    degraded_performance: "minor",
    partial_outage: "major",
    major_outage: "critical",
  };
  const byImpact: Record<IncidentImpact, PageIndicator> = {
    none: "none",
    minor: "minor",
    major: "major",
    critical: "critical",
  };
  const incident = (
    impact: IncidentImpact,
    overrides: Partial<Parameters<typeof pageIndicator>[1][number]> = {},
  ) => ({
    status: "investigating" as const,
    visibility: "published" as const,
    impact,
    ...overrides,
  });

  test.each(componentStatuses)("a %s component alone sets its indicator", (status) => {
    expect(pageIndicator([status], [])).toBe(byComponent[status]);
  });

  test.each(incidentImpacts)("an open published %s incident alone sets its indicator", (impact) => {
    expect(pageIndicator([], [incident(impact)])).toBe(byImpact[impact]);
  });

  test("takes the worst of components and incidents", () => {
    expect(pageIndicator(["degraded_performance", "operational"], [incident("major")])).toBe(
      "major",
    );
    expect(pageIndicator(["major_outage"], [incident("minor")])).toBe("critical");
    expect(pageIndicator([], [])).toBe("none");
  });

  test("only unresolved, published incidents count", () => {
    for (const status of incidentStatuses) {
      for (const visibility of incidentVisibilities) {
        const counts =
          visibility === "published" && status !== "resolved" && status !== "postmortem";
        expect(pageIndicator([], [incident("critical", { status, visibility })])).toBe(
          counts ? "critical" : "none",
        );
      }
    }
  });

  test("returns only Statuspage indicator values", () => {
    for (const status of componentStatuses) {
      expect(pageIndicators).toContain(pageIndicator([status], [incident("minor")]));
    }
  });
});
