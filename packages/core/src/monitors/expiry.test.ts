import type { SentWarning } from "@galena/contracts";
import fc from "fast-check";
import { expect, test } from "vitest";
import { daysLeft, dueWarning } from "./expiry.ts";

const expiresAt = "2026-11-20T12:00:00.000Z";
const daysBefore = (days: number) => new Date(Date.parse(expiresAt) - days * 86_400_000);

test("counts a part day as a whole one, so a warning's day count matches its threshold", () => {
  expect(daysLeft(expiresAt, daysBefore(7))).toBe(7);
  expect(daysLeft(expiresAt, daysBefore(6.5))).toBe(7);
  expect(daysLeft(expiresAt, daysBefore(0.1))).toBe(1);
  expect(daysLeft(expiresAt, daysBefore(-1))).toBe(-1);
});

test("warns nothing while more than 30 days are left", () => {
  expect(dueWarning(expiresAt, null, daysBefore(31))).toBeNull();
});

test("warns at the most urgent threshold crossed, not at every one", () => {
  expect(dueWarning(expiresAt, null, daysBefore(30))).toBe(30);
  expect(dueWarning(expiresAt, null, daysBefore(10))).toBe(14);
  expect(dueWarning(expiresAt, null, daysBefore(3))).toBe(7);
});

test("warns once per threshold, then again only at the next one", () => {
  const sent14 = { expiresAt, threshold: 14 } as const;
  expect(dueWarning(expiresAt, sent14, daysBefore(10))).toBeNull();
  expect(dueWarning(expiresAt, sent14, daysBefore(8))).toBeNull();
  expect(dueWarning(expiresAt, sent14, daysBefore(7))).toBe(7);
  expect(dueWarning(expiresAt, { expiresAt, threshold: 7 }, daysBefore(2))).toBeNull();
});

test("starts over for a renewed expiry date", () => {
  const renewed = "2027-02-18T12:00:00.000Z";
  const sentForOld = { expiresAt, threshold: 7 } as const;
  const tenDaysBeforeRenewed = new Date(Date.parse(renewed) - 10 * 86_400_000);
  expect(dueWarning(renewed, sentForOld, tenDaysBeforeRenewed)).toBe(14);
});

test("warns nothing once the expiry has passed", () => {
  expect(dueWarning(expiresAt, null, daysBefore(0))).toBeNull();
  expect(dueWarning(expiresAt, null, daysBefore(-3))).toBeNull();
});

test("over any run of scans, each threshold is sent once at most, most distant first", () => {
  // Scan times as minutes before the expiry, from 40 days out to 2 days after; sorted, they
  // run forward in time.
  const minutesBefore = fc.array(fc.integer({ min: -2 * 1440, max: 40 * 1440 }), {
    maxLength: 200,
  });
  fc.assert(
    fc.property(minutesBefore, (offsets) => {
      let sent: SentWarning | null = null;
      const warnings: number[] = [];
      for (const minutes of offsets.toSorted((a, b) => b - a)) {
        const due = dueWarning(expiresAt, sent, new Date(Date.parse(expiresAt) - minutes * 60_000));
        if (due === null) continue;
        warnings.push(due);
        sent = { expiresAt, threshold: due };
      }
      expect(warnings).toEqual([...new Set(warnings)].toSorted((a, b) => b - a));
      // A scan in the last 7 days always gets the 7-day warning out.
      if (offsets.some((minutes) => minutes > 0 && minutes <= 7 * 1440)) {
        expect(warnings.at(-1)).toBe(7);
      }
    }),
  );
});
