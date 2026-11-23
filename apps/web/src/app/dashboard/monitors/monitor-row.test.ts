import { expect, test } from "vitest";
import { percent, watches } from "./monitor-row.ts";

test("a monitor says what it watches: its URL, or a heartbeat's schedule", () => {
  const base = { http: null, heartbeat: null } as unknown as Parameters<typeof watches>[0];
  expect(watches({ ...base, http: { url: "https://example.com/" } } as typeof base)).toBe(
    "https://example.com/",
  );
  expect(
    watches({
      ...base,
      heartbeat: { periodMinutes: 1440, graceMinutes: 30, tokenIssuedAt: "" },
    } as typeof base),
  ).toBe("Checks in every day, with 30 minutes of grace");
});

test("uptime rounds down to two decimals, and 332 of 1,000 minutes down reads 66.80%", () => {
  expect(percent(1 - 1 / 44_640)).toBe("99.99%");
  expect(percent(1 - 332 / 1000)).toBe("66.80%");
  expect(percent(1)).toBe("100.00%");
});
