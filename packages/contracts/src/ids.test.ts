import { expect, test } from "vitest";
import { type ComponentId, componentId, type MonitorId, monitorId } from "./ids.ts";

const V7 = "01927f0a-7b3c-7cc4-9d2e-3f1a2b3c4d5e";

test("accepts a UUIDv7", () => {
  expect(monitorId.parse(V7)).toBe(V7);
});

test.each([
  ["a UUIDv4", "9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d"],
  ["a non-UUID", "mon_123"],
  ["an empty string", ""],
  ["a number", 42],
])("rejects %s", (_, input) => {
  expect(monitorId.safeParse(input).success).toBe(false);
});

test("IDs of different entities do not mix", () => {
  const monitor: MonitorId = monitorId.parse(V7);
  // @ts-expect-error a MonitorId is not a ComponentId
  const component: ComponentId = monitor;
  // @ts-expect-error a plain string is not an ID until a parser has checked it
  const unchecked: ComponentId = V7;
  expect([component, unchecked, componentId.parse(V7)]).toHaveLength(3);
});
