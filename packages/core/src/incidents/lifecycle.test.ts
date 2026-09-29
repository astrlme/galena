import { type IncidentStatus, incidentStatuses } from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { fixedClock } from "../ports.ts";
import { applyUpdate, canMoveTo, nextStatuses, startIncident } from "./lifecycle.ts";

const clock = fixedClock("2026-09-29T10:00:00.000Z");
const NOW = Date.parse("2026-09-29T10:00:00.000Z");

// The incident lifecycle diagram, edge by edge.
const DIAGRAM: ReadonlySet<string> = new Set([
  "investigating>identified",
  "investigating>monitoring",
  "investigating>resolved",
  "identified>monitoring",
  "identified>resolved",
  "monitoring>investigating",
  "monitoring>resolved",
  "resolved>postmortem",
]);
const isClosed = (s: IncidentStatus) => s === "resolved" || s === "postmortem";

describe("canMoveTo", () => {
  test.each(incidentStatuses)("%s may always post another update without moving", (status) => {
    expect(canMoveTo(status, status)).toBe(true);
  });

  test("allows exactly the moves in the lifecycle diagram", () => {
    for (const from of incidentStatuses) {
      for (const to of incidentStatuses) {
        if (from === to) continue;
        expect(canMoveTo(from, to), `${from} → ${to}`).toBe(DIAGRAM.has(`${from}>${to}`));
      }
    }
  });

  test("offers the current status first, then the moves the diagram allows", () => {
    expect(nextStatuses("investigating")).toEqual([
      "investigating",
      "identified",
      "monitoring",
      "resolved",
    ]);
    expect(nextStatuses("postmortem")).toEqual(["postmortem"]);
  });
});

describe("startIncident", () => {
  test("opens in any status but postmortem; one opened as resolved is resolved now", () => {
    expect(startIncident("investigating", clock)).toEqual({
      ok: true,
      value: { status: "investigating", resolvedAt: null },
    });
    expect(startIncident("resolved", clock)).toEqual({
      ok: true,
      value: { status: "resolved", resolvedAt: new Date(NOW) },
    });
    expect(startIncident("postmortem", clock)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  });
});

describe("applyUpdate", () => {
  test("resolving sets resolvedAt and says incident.resolved; a later postmortem keeps it", () => {
    const resolved = applyUpdate({ status: "monitoring", resolvedAt: null }, "resolved", clock);
    expect(resolved).toEqual({
      ok: true,
      value: {
        status: "resolved",
        resolvedAt: new Date(NOW),
        statusChanged: true,
        event: "incident.resolved",
      },
    });
    const earlier = new Date(NOW - 3_600_000);
    expect(applyUpdate({ status: "resolved", resolvedAt: earlier }, "postmortem", clock)).toEqual({
      ok: true,
      value: {
        status: "postmortem",
        resolvedAt: earlier,
        statusChanged: true,
        event: "incident.updated",
      },
    });
  });

  test("another update in the same status changes nothing but says incident.updated", () => {
    expect(applyUpdate({ status: "identified", resolvedAt: null }, "identified", clock)).toEqual({
      ok: true,
      value: {
        status: "identified",
        resolvedAt: null,
        statusChanged: false,
        event: "incident.updated",
      },
    });
  });

  test("refuses a move the diagram doesn't have, saying which moves it has", () => {
    expect(
      applyUpdate({ status: "resolved", resolvedAt: new Date(NOW) }, "investigating", clock),
    ).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "illegal_transition",
          "message": "A resolved incident can move to postmortem only.",
        },
        "ok": false,
      }
    `);
  });

  test("property: any sequence of requests only ever takes diagram moves", () => {
    const status = fc.constantFrom(...incidentStatuses);
    fc.assert(
      fc.property(status, fc.array(status, { maxLength: 30 }), (first, requests) => {
        const started = startIncident(first, clock);
        if (!started.ok) return first === "postmortem";
        let current = started.value;
        for (const to of requests) {
          const step = applyUpdate(current, to, clock);
          if (!step.ok) {
            // Refused exactly when the diagram has no such move.
            expect(to !== current.status && !DIAGRAM.has(`${current.status}>${to}`)).toBe(true);
            continue;
          }
          if (step.value.statusChanged) {
            expect(DIAGRAM.has(`${current.status}>${step.value.status}`)).toBe(true);
          }
          current = step.value;
          // resolvedAt is set exactly while the incident is resolved or in postmortem.
          expect(current.resolvedAt !== null).toBe(isClosed(current.status));
        }
        return true;
      }),
      { numRuns: 10_000 },
    );
  });
});
