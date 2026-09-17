import { expect, test } from "vitest";
import { z } from "zod";
import { eventEnvelope } from "./events.ts";

const incidentResolved = eventEnvelope("incident.resolved", z.object({ incidentId: z.string() }));
const valid = {
  id: "01927f0a-7b3c-7cc4-9d2e-3f1a2b3c4d5e",
  type: "incident.resolved",
  occurredAt: "2026-09-26T14:02:00.000Z",
  workspaceId: "01927f0a-0000-7000-8000-000000000001",
  data: { incidentId: "inc" },
};

test("accepts a well-formed envelope", () => {
  expect(incidentResolved.parse(valid)).toEqual(valid);
});

test.each([
  ["another event type", { type: "incident.created" }],
  ["a time with an offset instead of UTC", { occurredAt: "2026-09-26T16:02:00+02:00" }],
  ["a date without a time", { occurredAt: "2026-09-26" }],
  ["an id that is not a UUIDv7", { id: "9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d" }],
  ["a missing workspace", { workspaceId: undefined }],
  ["data of the wrong shape", { data: { incidentId: 7 } }],
])("rejects %s", (_, change) => {
  expect(incidentResolved.safeParse({ ...valid, ...change }).success).toBe(false);
});
