/// <reference types="node" />
// `pnpm replay`: every `<scenario>.jsonl` in test/fixtures/replay goes through the real reducer
// and must produce exactly the transitions in `<scenario>.expected.json`; those transitions then
// drive autopilot, whose incident updates must match `<scenario>.autopilot.json`. One event per
// line, in time order (see `Line`); expectations are worked out by hand, never copied from a run.
import { readdirSync, readFileSync } from "node:fs";
import {
  type CheckStatus,
  checkResult,
  componentId,
  type DetectionSettings,
  detectionSettings,
  eventId,
  type IncidentStatus,
  incidentId,
  type MonitorState,
  monitorId,
  workspaceId,
} from "@galena/contracts";
import { expect, test } from "vitest";
import { planAutopilot } from "../incidents/autopilot.ts";
import { fixedClock, type Incident } from "../ports.ts";
import { type CanaryTrack, nextCanary } from "./canary.ts";
import { evaluate, initialDetectionState } from "./evaluate.ts";

const FIXTURES = new URL("../../../../test/fixtures/replay/", import.meta.url);
const MONITOR = monitorId.parse("01920000-0000-7000-8000-0000000000a1");
const EVENT = eventId.parse("01920000-0000-7000-8000-0000000000e1");
/** Checks are evaluated a few seconds after their scheduled minute. */
const EVALUATION_DELAY = 5_000;

type Line =
  | { type: "settings"; detection: Partial<DetectionSettings> }
  | { type: "check"; at: string; region: string; status: CheckStatus; latencyMs?: number }
  | { type: "canary"; at: string; region: string; passed: boolean }
  | { type: "maintenance"; at: string; active: boolean };

type Replayed = { at: string; from: MonitorState; to: MonitorState; suppressed: boolean };

function replay(lines: Line[]): Replayed[] {
  let settings = detectionSettings.parse({});
  let state = initialDetectionState();
  const canaries = new Map<string, CanaryTrack>();
  let inMaintenance = false;
  const transitions: Replayed[] = [];

  for (const line of lines) {
    switch (line.type) {
      case "settings":
        settings = detectionSettings.parse(line.detection);
        break;
      case "canary":
        canaries.set(
          line.region,
          nextCanary(canaries.get(line.region) ?? { excluded: false, passes: 0 }, line.passed),
        );
        break;
      case "maintenance":
        inMaintenance = line.active;
        break;
      case "check": {
        const failed = line.status === "down" || line.status === "error";
        const result = checkResult.parse({
          monitorId: MONITOR,
          region: line.region,
          scheduledAt: line.at,
          checkedAt: line.at,
          status: line.status,
          httpStatus: line.status === "error" ? null : line.status === "down" ? 503 : 200,
          latencyMs: line.status === "error" ? null : (line.latencyMs ?? 150),
          phases: null,
          error: failed
            ? { code: line.status === "down" ? "http_status" : "probe_failed", message: "replay" }
            : null,
          eventId: EVENT,
        });
        const excludedRegions = new Set(
          [...canaries].filter(([, track]) => track.excluded).map(([region]) => region),
        );
        const clock = fixedClock(new Date(Date.parse(line.at) + EVALUATION_DELAY).toISOString());
        const { next, transition } = evaluate(state, result, settings, {
          clock,
          excludedRegions,
          inMaintenance,
        });
        if (transition) {
          transitions.push({
            at: new Date(transition.at).toISOString(),
            from: transition.from,
            to: transition.to,
            suppressed: transition.suppressed,
          });
        }
        state = next;
        break;
      }
      default:
        throw new Error(`Unknown replay line: ${JSON.stringify(line)}`);
    }
  }
  return transitions;
}

const scenarios = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".jsonl"))
  .map((file) => file.replace(/\.jsonl$/, ""));

test("the six required scenarios are present", () => {
  expect(scenarios).toEqual(
    expect.arrayContaining([
      "clean-outage",
      "single-region-blip",
      "probe-region-down",
      "flapping-endpoint",
      "latency-degradation",
      "outage-during-maintenance",
    ]),
  );
});

const read = (name: string, suffix: string) =>
  readFileSync(new URL(`${name}${suffix}`, FIXTURES), "utf8");
const linesOf = (name: string) =>
  read(name, ".jsonl")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);

test.each(scenarios)("%s replays to exactly its expected transitions", (name) => {
  expect(replay(linesOf(name))).toEqual(JSON.parse(read(name, ".expected.json")));
});

/** The updates autopilot posts on the incident it opens, as the transitions arrive. */
function autopilotUpdates(transitions: readonly Replayed[]) {
  const api = componentId.parse("01920000-0000-7000-8000-000000000011");
  const monitor = {
    id: MONITOR,
    componentId: api,
    componentName: "API",
    publishPolicy: "auto" as const,
    downStatus: "major_outage" as const,
    stableMinutes: detectionSettings.parse({}).stableMinutes,
  };
  let open: Incident | undefined;
  const updates: { at: string; status: IncidentStatus }[] = [];
  for (const t of transitions) {
    const now = new Date(t.at);
    const plan = planAutopilot({ ...t, monitor, openIncidents: open ? [open] : [], now });
    if (plan.action === "open") {
      open = {
        id: incidentId.parse("01920000-0000-7000-8000-000000000101"),
        workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
        title: plan.title,
        status: "investigating",
        impact: plan.impact,
        visibility: plan.visibility,
        source: "monitor",
        startedAt: now,
        resolvedAt: null,
        updatedAt: now,
        components: plan.components,
        dedupKey: plan.dedupKey,
      };
      updates.push({ at: t.at, status: "investigating" });
    } else if (plan.action === "update" && open) {
      updates.push({ at: t.at, status: plan.status });
      open = plan.status === "resolved" ? undefined : { ...open, status: plan.status };
    }
  }
  return updates;
}

test.each(scenarios)("%s drives autopilot to exactly its expected incident updates", (name) => {
  const transitions = JSON.parse(read(name, ".expected.json")) as Replayed[];
  expect(autopilotUpdates(transitions)).toEqual(JSON.parse(read(name, ".autopilot.json")));
});
