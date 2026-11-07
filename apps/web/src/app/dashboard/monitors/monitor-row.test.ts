import { expect, test } from "vitest";
import { watches } from "./monitor-row.ts";

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
