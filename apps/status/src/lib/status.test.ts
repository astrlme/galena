import { expect, test } from "vitest";
import { duration, utcDateTime } from "./format.ts";
import { renderMarkdown } from "./markdown.ts";
import { rowLabel, rowState } from "./row.ts";

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

test("a component nothing reports on shows no data; older snapshots read as observed", () => {
  expect(rowState({ status: "operational", observed: false })).toBe("no_data");
  expect(rowLabel({ status: "operational", observed: false })).toBe("No data");
  expect(rowState({ status: "partial_outage", observed: true })).toBe("partial_outage");
  expect(rowLabel({ status: "partial_outage" })).toBe("Partial outage");
});
