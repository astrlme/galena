import { expect, test } from "vitest";
import { duration, utcDateTime } from "./format.ts";
import { renderMarkdown } from "./markdown.ts";
import { describeDay, stripPaths, stripWidth } from "./strip.ts";

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

test("the strip draws one path per kind of mark, 6 px apart", () => {
  const paths = stripPaths([
    { date: "2026-09-27", worst: null, downMinutes: 0 },
    { date: "2026-09-28", worst: "major_outage", downMinutes: 60 },
    { date: "2026-09-29", worst: "operational", downMinutes: 0 },
  ]);
  expect(paths).toEqual([
    { className: "m-none", d: "M1.5 26h1v1h-1z" },
    { className: "m-major", d: "M6 1h4v26h-4z" },
    { className: "m-ok", d: "M12 22h4v5h-4z" },
  ]);
  expect(stripWidth(90)).toBe(538);
  expect(describeDay({ date: "2026-09-28", worst: "major_outage", downMinutes: 60 })).toBe(
    "Major outage, 60 minutes down",
  );
});
