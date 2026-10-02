import { type ComponentStatus, componentId, monitorId } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type ComponentHistory,
  dayMark,
  type RollupInputs,
  rollupUptime,
  SEVERITY_RANK,
  statusMinutes,
} from "./uptime.ts";

const DAY = 86_400_000;
const DAY0 = Date.parse("2026-09-29T00:00:00.000Z");
const at = (h: number, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const none: ComponentHistory = { monitors: [], incidents: [], maintenance: [] };
/** One monitor that has reported up since before the day began. */
const watched: ComponentHistory = {
  ...none,
  monitors: [{ downStatus: "major_outage", changes: [{ at: at(0) - DAY, state: "up" }] }],
};

describe("statusMinutes", () => {
  test("a component no monitor reports on has no minutes at all", () => {
    expect(statusMinutes(none, DAY0, DAY0 + DAY)).toEqual({});
  });

  test("incidents and windows without a reporting monitor add no history", () => {
    const history: ComponentHistory = {
      ...none,
      incidents: [{ from: at(2), to: at(3), status: "major_outage" }],
      maintenance: [{ from: at(5), to: at(6) }],
    };
    expect(statusMinutes(history, DAY0, DAY0 + DAY)).toEqual({});
  });

  test("minutes before a monitor's first verdict are not observed", () => {
    const history: ComponentHistory = {
      ...none,
      monitors: [
        {
          downStatus: "major_outage",
          changes: [
            { at: at(0) - DAY, state: "unknown" },
            { at: at(6), state: "up" },
          ],
        },
      ],
    };
    expect(statusMinutes(history, DAY0, DAY0 + DAY)).toEqual({ operational: 1080 });
  });

  test("a monitor's down spell counts in its downStatus, the rest operational", () => {
    const history: ComponentHistory = {
      ...none,
      monitors: [
        {
          downStatus: "partial_outage",
          changes: [
            { at: at(0) - DAY, state: "up" },
            { at: at(10), state: "down" },
            { at: at(10, 45), state: "recovering" },
          ],
        },
      ],
    };
    expect(statusMinutes(history, DAY0, DAY0 + DAY)).toEqual({
      operational: 1395,
      partial_outage: 45,
    });
  });

  test("an incident's component status joins the worst; maintenance overrides both", () => {
    const history: ComponentHistory = {
      monitors: [{ downStatus: "major_outage", changes: [{ at: at(0), state: "up" }] }],
      incidents: [{ from: at(2), to: at(3), status: "degraded_performance" }],
      maintenance: [{ from: at(2, 30), to: at(4) }],
    };
    expect(statusMinutes(history, DAY0, DAY0 + DAY)).toEqual({
      operational: 1320,
      degraded_performance: 30,
      under_maintenance: 90,
    });
  });

  test("today counts only up to now", () => {
    expect(statusMinutes(watched, DAY0, at(6))).toEqual({ operational: 360 });
  });
});

describe("dayMark", () => {
  test("the worst state that lasted a minute, with outage minutes as downtime", () => {
    expect(dayMark({ operational: 1395, partial_outage: 45 })).toEqual({
      worst: "partial_outage",
      downMinutes: 45,
    });
    // Under a minute is noise; maintenance is never downtime.
    expect(dayMark({ operational: 1439.5, major_outage: 0.5 })).toEqual({
      worst: "operational",
      downMinutes: 0,
    });
    expect(dayMark({ operational: 1350, under_maintenance: 90 })).toEqual({
      worst: "under_maintenance",
      downMinutes: 0,
    });
    expect(dayMark({})).toEqual({ worst: null, downMinutes: 0 });
  });

  test("property: a day's mark never ranks below any state that lasted a minute", () => {
    const state = fc.constantFrom("unknown", "up", "degraded", "down", "recovering", "flapping");
    const minute = fc.integer({ min: 0, max: 1439 });
    fc.assert(
      fc.property(
        fc.array(fc.record({ minute, state }), { maxLength: 12 }),
        fc.array(fc.record({ from: minute, length: fc.integer({ min: 1, max: 300 }) }), {
          maxLength: 3,
        }),
        (changes, windows) => {
          const history: ComponentHistory = {
            monitors: [
              {
                downStatus: "major_outage",
                changes: changes
                  .map((c) => ({ at: DAY0 + c.minute * 60_000, state: c.state }))
                  .sort((a, b) => a.at - b.at),
              },
            ],
            incidents: [],
            maintenance: windows.map((w) => ({
              from: DAY0 + w.from * 60_000,
              to: DAY0 + (w.from + w.length) * 60_000,
            })),
          };
          const minutes = statusMinutes(history, DAY0, DAY0 + DAY);
          const total = Object.values(minutes).reduce((sum, m) => sum + m, 0);
          expect(total).toBeLessThanOrEqual(1440 + 1e-9);
          const { worst } = dayMark(minutes);
          for (const [status, spent] of Object.entries(minutes) as [ComponentStatus, number][]) {
            if (spent >= 1 && worst) {
              expect(SEVERITY_RANK[status]).toBeLessThanOrEqual(SEVERITY_RANK[worst]);
            }
          }
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

describe("rollupUptime", () => {
  const api = componentId.parse("01920000-0000-7000-8000-000000000011");
  const web = componentId.parse("01920000-0000-7000-8000-000000000012");
  const docs = componentId.parse("01920000-0000-7000-8000-000000000013");
  const probe = monitorId.parse("01920000-0000-7000-8000-000000000021");
  const webProbe = monitorId.parse("01920000-0000-7000-8000-000000000022");
  const now = new Date(at(12));
  const inputs: RollupInputs = {
    // `docs` has no monitor, so it gets no history.
    components: [{ id: api }, { id: web }, { id: docs }],
    monitors: [
      { id: probe, componentId: api, downStatus: "major_outage" },
      { id: webProbe, componentId: web, downStatus: "major_outage" },
    ],
    transitions: [
      { monitorId: probe, state: "up", at: new Date(at(0) - 3 * DAY) },
      { monitorId: probe, state: "down", at: new Date(at(-1)) },
      { monitorId: probe, state: "up", at: new Date(at(0, 30)) },
      { monitorId: webProbe, state: "up", at: new Date(at(0) - 3 * DAY) },
    ],
    incidents: [],
    maintenance: [],
  };

  test("covers yesterday whole and today up to now, for every monitored component", () => {
    expect(rollupUptime(inputs, now)).toEqual([
      { componentId: api, date: "2026-09-28", minutes: { operational: 1380, major_outage: 60 } },
      { componentId: api, date: "2026-09-29", minutes: { major_outage: 30, operational: 690 } },
      { componentId: web, date: "2026-09-28", minutes: { operational: 1440 } },
      { componentId: web, date: "2026-09-29", minutes: { operational: 720 } },
    ]);
  });

  test("only published incidents and windows that were not cancelled count", () => {
    // The internal incident and the cancelled window would each add an hour if they counted.
    const incident = (visibility: "published" | "internal", hour: number) => ({
      visibility,
      startedAt: new Date(at(hour)),
      resolvedAt: new Date(at(hour + 1)),
      components: [{ componentId: web, status: "partial_outage" as const }],
    });
    const window = (cancelledAt: Date | null, hour: number) => ({
      startsAt: new Date(at(hour)),
      endsAt: new Date(at(hour + 1)),
      cancelledAt,
      componentIds: [web],
    });
    const days = rollupUptime(
      {
        ...inputs,
        incidents: [incident("published", 1), incident("internal", 5)],
        maintenance: [window(null, 3), window(new Date(at(0)), 7)],
      },
      now,
    );
    expect(days.find((d) => d.componentId === web && d.date === "2026-09-29")?.minutes).toEqual({
      operational: 600,
      partial_outage: 60,
      under_maintenance: 60,
    });
  });

  test("an open incident lasts until now", () => {
    const days = rollupUptime(
      {
        ...inputs,
        incidents: [
          {
            visibility: "published",
            startedAt: new Date(at(11)),
            resolvedAt: null,
            components: [{ componentId: web, status: "degraded_performance" }],
          },
        ],
      },
      now,
    );
    expect(days.find((d) => d.componentId === web && d.date === "2026-09-29")?.minutes).toEqual({
      operational: 660,
      degraded_performance: 60,
    });
  });
});
