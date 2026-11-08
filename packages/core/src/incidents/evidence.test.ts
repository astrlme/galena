import { monitorId } from "@galena/contracts";
import { expect, test } from "vitest";
import { monitorDedupKey } from "./autopilot.ts";
import { evidenceWindow, monitorOfIncident } from "./evidence.ts";

const at = (time: string) => new Date(`2026-11-08T${time}:00.000Z`);

test("reads from 30 minutes before the start to the end in one piece when it is short", () => {
  expect(evidenceWindow(at("10:00"), at("10:20"))).toEqual({
    from: at("09:30"),
    to: at("10:20"),
    gap: null,
    reads: [{ from: at("09:30"), to: at("10:20") }],
  });
  expect(evidenceWindow(at("10:00"), at("11:30")).gap).toBeNull();
});

test("keeps the hour around the start and the latest hour of a long incident, not the middle", () => {
  expect(evidenceWindow(at("10:00"), at("11:31"))).toEqual({
    from: at("09:30"),
    to: at("11:31"),
    gap: { from: at("10:30"), to: at("10:31") },
    reads: [
      { from: at("09:30"), to: at("10:30") },
      { from: at("10:31"), to: at("11:31") },
    ],
  });
  const nextDay = new Date("2026-11-09T10:00:00.000Z");
  expect(evidenceWindow(at("10:00"), nextDay).reads).toEqual([
    { from: at("09:30"), to: at("10:30") },
    { from: new Date("2026-11-09T09:00:00.000Z"), to: nextDay },
  ]);
});

test("finds the monitor behind its own incidents only", () => {
  const id = monitorId.parse("01920000-0000-7000-8000-0000000000aa");
  expect(monitorOfIncident(monitorDedupKey(id))).toBe(id);
  expect(monitorOfIncident("sig:01920000-0000-7000-8000-0000000000bb:abc")).toBeNull();
  expect(monitorOfIncident("mon:not-a-uuid")).toBeNull();
  expect(monitorOfIncident(null)).toBeNull();
});
