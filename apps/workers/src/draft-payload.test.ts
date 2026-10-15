import type { IncidentId, WorkspaceId } from "@galena/contracts";
import { expect, test } from "vitest";
import { draftPayloadOf } from "./autopilot.ts";

const workspaceId = "01920000-0000-7000-8000-000000000001" as WorkspaceId;
const id = "01a13cac-c55c-74d0-abc4-5200d1afd180" as IncidentId;
const monitor = "01a13cac-a495-74b8-9c33-6a52c1a8e0d4";

test("a monitor's stored draft names its monitor, so the deadline reads the monitor's state", () => {
  expect(
    draftPayloadOf({ id, workspaceId, source: "monitor", dedupKey: `mon:${monitor}` }),
  ).toEqual({ workspaceId, incidentId: id, monitorId: monitor });
});

test("an alert group's or a person's draft names no monitor", () => {
  const sig = { id, workspaceId, source: "signal", dedupKey: "sig:int:fp" };
  expect(draftPayloadOf(sig)).toEqual({ workspaceId, incidentId: id });
  const manual = { id, workspaceId, source: "manual", dedupKey: null };
  expect(draftPayloadOf(manual)).toEqual({ workspaceId, incidentId: id });
});
