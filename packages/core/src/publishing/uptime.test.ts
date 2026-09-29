import type { ComponentStatus } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type ComponentHistory, dayMark, SEVERITY_RANK, statusMinutes } from "./uptime.ts";

const DAY = 86_400_000;
const DAY0 = Date.parse("2026-09-29T00:00:00.000Z");
const at = (h: number, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const none: ComponentHistory = { monitors: [], incidents: [], maintenance: [] };

describe("statusMinutes", () => {
  test("a component nothing has an opinion about is operational all day", () => {
    expect(statusMinutes(none, DAY0, DAY0 + DAY)).toEqual({ operational: 1440 });
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
    expect(statusMinutes(none, DAY0, at(6))).toEqual({ operational: 360 });
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
          expect(total).toBeCloseTo(1440);
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
