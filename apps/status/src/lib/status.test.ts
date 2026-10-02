import { expect, test } from "vitest";
import { duration, utcDateTime } from "./format.ts";
import { renderMarkdown } from "./markdown.ts";
import { rowLabel, rowState } from "./row.ts";
import { dayDetail, describeDay, stripPaths, stripWidth } from "./strip.ts";

test("markdown: a safe subset, with everything else escaped", () => {
  expect(
    renderMarkdown("**API** errors, see [notes](https://example.com/x).\n\n- one\n- *two*"),
  ).toBe(
    '<p><strong>API</strong> errors, see <a href="https://example.com/x">notes</a>.</p><ul><li>one</li><li><em>two</em></li></ul>',
  );
  expect(renderMarkdown('<img src=x onerror="alert(1)"> [x](javascript:alert(1))')).toBe(
    "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; [x](javascript:alert(1))</p>",
  );
});

test("times and durations read the same everywhere", () => {
  expect(utcDateTime("2026-09-12T14:02:30.000Z")).toBe("12 Sep, 14:02 UTC");
  expect(duration("2026-09-12T14:00:00.000Z", "2026-09-12T14:42:00.000Z")).toBe("42 minutes");
  expect(duration("2026-09-12T14:00:00.000Z", "2026-09-12T16:05:00.000Z")).toBe(
    "2 hours 5 minutes",
  );
  expect(duration("2026-09-12T14:00:00.000Z", "2026-09-15T18:00:00.000Z")).toBe("3 days 4 hours");
});

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

test("a component nothing reports on shows no data; older snapshots read as observed", () => {
  expect(rowState({ status: "operational", observed: false })).toBe("no_data");
  expect(rowLabel({ status: "operational", observed: false })).toBe("No data");
  expect(rowState({ status: "partial_outage", observed: true })).toBe("partial_outage");
  expect(rowLabel({ status: "partial_outage" })).toBe("Partial outage");
});
