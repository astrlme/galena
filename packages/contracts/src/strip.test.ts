import { expect, test } from "vitest";
import { dayDetail, describeDay, monitorStripDay, stripPaths, stripWidth } from "./strip.ts";

test("each day is a green column; a bad day's state fills its foot, 1 px below the green", () => {
  const paths = stripPaths([
    { date: "2026-09-26", worst: null, downMinutes: 0 },
    { date: "2026-09-27", worst: "major_outage", downMinutes: 60 },
    { date: "2026-09-28", worst: "operational", downMinutes: 0 },
    { date: "2026-09-29", worst: "partial_outage", downMinutes: 20 },
  ]);
  // Without minutes (snapshots from before they were kept) the foot's height is the severity's.
  expect(paths).toEqual([
    { className: "m-none", d: "M1.5 26h1v1h-1z" },
    { className: "m-major", d: "M6 0h4v27h-4z" },
    { className: "m-ok", d: "M12 0h4v27h-4zM18 0h4v7h-4z" },
    { className: "m-partial", d: "M18 8h4v19h-4z" },
  ]);
  expect(stripWidth(90)).toBe(538);

  // With minutes, each state's share of the day sets its height, worst at the bottom, 1 px
  // apart: at least 8 px for an outage, 3 px otherwise; a whole day of one state fills the column.
  expect(
    stripPaths([
      {
        date: "2026-09-28",
        worst: "major_outage",
        downMinutes: 60,
        minutes: { operational: 1380, major_outage: 60 },
      },
      {
        date: "2026-09-29",
        worst: "major_outage",
        downMinutes: 360,
        minutes: { operational: 720, degraded_performance: 360, major_outage: 360 },
      },
      {
        date: "2026-09-30",
        worst: "major_outage",
        downMinutes: 1440,
        minutes: { major_outage: 1440 },
      },
    ]),
  ).toEqual([
    { className: "m-major", d: "M0 19h4v8h-4zM6 19h4v8h-4zM12 0h4v27h-4z" },
    { className: "m-ok", d: "M0 0h4v18h-4zM6 0h4v10h-4z" },
    { className: "m-degraded", d: "M6 11h4v7h-4z" },
  ]);
  expect(describeDay({ date: "2026-09-28", worst: "major_outage", downMinutes: 60 })).toBe(
    "Major outage, 60 minutes down",
  );
  expect(describeDay({ date: "2026-09-28", worst: "major_outage", downMinutes: 1 })).toBe(
    "Major outage, 1 minute down",
  );
});

test("a day's popover: minutes per state, then the incidents that touched the component", () => {
  const api = "01920000-0000-7000-8000-000000000011";
  const incident = (id: string, startedAt: string, resolvedAt: string | null, componentId = api) =>
    ({
      id,
      title: `Incident ${id.slice(-1)}`,
      status: resolvedAt ? "resolved" : "identified",
      impact: "major",
      startedAt,
      resolvedAt,
      updatedAt: startedAt,
      components: [{ componentId, status: "partial_outage" }],
      updates: [],
    }) as never;
  const day = {
    date: "2026-10-01",
    worst: "degraded_performance" as const,
    downMinutes: 0,
    minutes: { degraded_performance: 52, operational: 1388 },
  };
  const incidents = [
    incident("x1", "2026-10-01T09:44:00.000Z", "2026-10-01T10:36:00.000Z"),
    incident("x2", "2026-09-29T09:00:00.000Z", "2026-09-29T10:00:00.000Z"), // another day
    incident("x3", "2026-10-01T12:00:00.000Z", null, "01920000-0000-7000-8000-000000000012"),
    incident("x4", "2026-09-30T23:30:00.000Z", null), // still open
  ];
  expect(dayDetail(day, incidents, api, "2026-10-02T08:00:00.000Z")).toEqual({
    t: "Degraded performance",
    m: [
      ["operational", 1388],
      ["degraded_performance", 52],
    ],
    n: [
      ["Incident 1", "2026-10-01T09:44:00.000Z", "2026-10-01T10:36:00.000Z", "partial_outage"],
      ["Incident 4", "2026-09-30T23:30:00.000Z", null, "partial_outage"],
    ],
  });
  // A whole operational day with nothing on it needs no detail; the page fills it in.
  const calm = { date: "2026-09-29", worst: "operational" as const, downMinutes: 0 };
  expect(dayDetail({ ...calm, minutes: { operational: 1440 } }, [], api, "2026-10-02")).toBe(
    undefined,
  );
  expect(dayDetail({ date: "2026-07-01", worst: null, downMinutes: 0 }, [], api, "x")).toBe(
    undefined,
  );
});

test("a monitor's day: its down minutes are a foot in the state it marks while down", () => {
  expect(
    monitorStripDay({ date: "2026-11-01", minutes: 0, minutesDown: 0 }, "major_outage"),
  ).toEqual({ date: "2026-11-01", worst: null, downMinutes: 0 });
  const clean = monitorStripDay(
    { date: "2026-11-02", minutes: 1440, minutesDown: 0 },
    "major_outage",
  );
  expect(describeDay(clean)).toBe("Operational");
  const bad = monitorStripDay(
    { date: "2026-11-03", minutes: 1440, minutesDown: 90 },
    "partial_outage",
  );
  expect(bad).toMatchObject({
    worst: "partial_outage",
    minutes: { operational: 1350, partial_outage: 90 },
  });
  expect(describeDay(bad)).toBe("Partial outage, 90 minutes down");
  expect(stripPaths([bad]).map((p) => p.className)).toEqual(["m-partial", "m-ok"]);
});
