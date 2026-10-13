import {
  componentId,
  type IncidentStatus,
  incidentId,
  integrationId,
  publishPolicies,
  type Route,
  signalStatuses,
  workspaceId,
} from "@galena/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { Incident } from "../ports.ts";
import { planSignal, routeAlerts, signalDedupKey } from "./signals.ts";

const api = componentId.parse("01920000-0000-7000-8000-000000000011");
const db = componentId.parse("01920000-0000-7000-8000-000000000012");
const web = componentId.parse("01920000-0000-7000-8000-000000000013");
const gone = componentId.parse("01920000-0000-7000-8000-0000000000ff");
const names = new Map([
  [api, "API"],
  [db, "Database"],
  [web, "Web"],
]);
const now = new Date("2026-10-13T10:00:00Z");
const key = signalDedupKey(integrationId.parse("01920000-0000-7000-8000-0000000000b1"), "grp");

const incident = (status: IncidentStatus, dedupKey: string | null): Incident => ({
  id: incidentId.parse(
    dedupKey ? "01920000-0000-7000-8000-000000000102" : "01920000-0000-7000-8000-000000000101",
  ),
  workspaceId: workspaceId.parse("01920000-0000-7000-8000-000000000001"),
  title: "API is down",
  status,
  impact: "major",
  visibility: "published",
  source: dedupKey ? "signal" : "manual",
  startedAt: now,
  resolvedAt: null,
  updatedAt: now,
  components: [{ componentId: api, status: "major_outage" }],
  dedupKey,
});
const own = (status: IncidentStatus = "investigating") => incident(status, key);
const manual = incident("investigating", null);

const plan = (over: Partial<Parameters<typeof planSignal>[0]> = {}) =>
  planSignal({
    status: "firing",
    dedupKey: key,
    policy: "approve",
    routed: [{ componentId: api, status: "major_outage" }],
    componentNames: names,
    inMaintenance: false,
    own: null,
    covering: [],
    now,
    ...over,
  });

describe("routeAlerts", () => {
  const routes: Route[] = [
    { match: { severity: "critical" }, componentIds: [api], downStatus: "major_outage" },
    { match: { service: "api" }, componentIds: [api, web], downStatus: "partial_outage" },
    { match: {}, componentIds: [db], downStatus: "partial_outage" },
  ];

  test("an alert takes the first route whose labels all match", () => {
    expect(routeAlerts([{ service: "api", region: "eu" }], routes)).toEqual([
      { componentId: api, status: "partial_outage" },
      { componentId: web, status: "partial_outage" },
    ]);
  });

  test("a route with no labels matches any alert the routes above it missed", () => {
    expect(routeAlerts([{ service: "billing" }], routes)).toEqual([
      { componentId: db, status: "partial_outage" },
    ]);
  });

  test("components are the union across alerts, each at its worst status", () => {
    expect(
      routeAlerts([{ service: "api" }, { service: "api", severity: "critical" }], routes),
    ).toEqual([
      { componentId: api, status: "major_outage" },
      { componentId: web, status: "partial_outage" },
    ]);
  });

  test("an alert matching no route marks nothing", () => {
    expect(routeAlerts([{ service: "billing" }], routes.slice(0, 2))).toEqual([]);
    expect(routeAlerts([{ service: "api" }], [])).toEqual([]);
  });
});

describe("planSignal: firing", () => {
  test("an approve integration drafts an incident that waits 10 minutes", () => {
    expect(plan()).toEqual({
      action: "open",
      dedupKey: key,
      visibility: "draft",
      title: "API is down",
      body: "We're seeing errors on API from our monitoring. We're investigating and will update by 10:30 UTC.",
      impact: "major",
      components: [{ componentId: api, status: "major_outage" }],
      approvalDeadline: new Date("2026-10-13T10:10:00Z"),
    });
  });

  test("an auto integration publishes at once", () => {
    expect(plan({ policy: "auto" })).toMatchObject({
      action: "open",
      visibility: "published",
      approvalDeadline: null,
    });
  });

  test("several components are named in one title and body", () => {
    const routed = [api, db, web].map((id) => ({
      componentId: id,
      status: "major_outage" as const,
    }));
    expect(plan({ routed })).toMatchObject({
      title: "API, Database and Web are down",
      body: expect.stringContaining("errors on API, Database and Web from"),
    });
    expect(plan({ routed: routed.slice(0, 2) })).toMatchObject({
      title: "API and Database are down",
    });
  });

  test("a deleted component is skipped, and with none left nothing opens", () => {
    const deleted = { componentId: gone, status: "major_outage" as const };
    expect(
      plan({ routed: [deleted, { componentId: db, status: "partial_outage" }] }),
    ).toMatchObject({ components: [{ componentId: db, status: "partial_outage" }] });
    expect(plan({ routed: [deleted] })).toEqual({ action: "none", outcome: "no_route" });
  });

  test("its own open incident makes a repeat notification a no-op", () => {
    expect(plan({ own: own() })).toEqual({ action: "none", outcome: "repeat" });
  });

  test("an incident already open on a routed component takes the alert", () => {
    expect(plan({ covering: [manual] })).toEqual({ action: "attach", incidentId: manual.id });
  });

  test("internal_only and maintenance open nothing", () => {
    expect(plan({ policy: "internal_only" })).toEqual({ action: "none", outcome: "internal_only" });
    expect(plan({ inMaintenance: true })).toEqual({ action: "none", outcome: "suppressed" });
  });
});

describe("planSignal: resolved", () => {
  test("resolves the incident the group opened", () => {
    expect(plan({ status: "resolved", own: own("investigating") })).toEqual({
      action: "update",
      incidentId: own().id,
      expected: "investigating",
      status: "resolved",
      body: "API has worked normally since 10:00 UTC. Our alerts have cleared.",
    });
  });

  test("resolves it whatever the policy, maintenance or routes say now", () => {
    expect(
      plan({
        status: "resolved",
        own: own("monitoring"),
        policy: "internal_only",
        inMaintenance: true,
        routed: [],
      }),
    ).toMatchObject({ action: "update", expected: "monitoring", status: "resolved" });
  });

  test("without an incident of its own there is nothing to resolve", () => {
    expect(plan({ status: "resolved", covering: [manual] })).toEqual({
      action: "none",
      outcome: "no_incident",
    });
  });
});

describe("planSignal: properties", () => {
  const inputs = fc.record({
    status: fc.constantFrom(...signalStatuses),
    policy: fc.constantFrom(...publishPolicies),
    routed: fc
      .subarray([api, db, gone])
      .map((ids) => ids.map((id) => ({ componentId: id, status: "major_outage" as const }))),
    inMaintenance: fc.boolean(),
    own: fc.option(fc.constantFrom<IncidentStatus>("investigating", "identified", "monitoring")),
    covering: fc.boolean(),
  });
  type Inputs = typeof inputs extends fc.Arbitrary<infer T> ? T : never;
  const run = (i: Inputs) =>
    plan({
      status: i.status,
      policy: i.policy,
      routed: i.routed,
      inMaintenance: i.inMaintenance,
      own: i.own ? own(i.own) : null,
      covering: i.covering ? [manual] : [],
    });

  test("a resolved group never opens or attaches, and only ever touches its own incident", () => {
    fc.assert(
      fc.property(inputs, (i) => {
        const p = run({ ...i, status: "resolved" });
        expect(p.action === "update" ? p.incidentId : p.action).toBe(i.own ? own().id : "none");
      }),
      { numRuns: 2_000 },
    );
  });

  test("a firing group opens only with no incident of its own or covering, a named component, a publishing policy and no maintenance", () => {
    fc.assert(
      fc.property(inputs, (i) => {
        const p = run({ ...i, status: "firing" });
        const named = i.routed.some((r) => names.has(r.componentId));
        const mayOpen =
          !i.own && !i.covering && named && i.policy !== "internal_only" && !i.inMaintenance;
        expect(p.action === "open").toBe(mayOpen);
        if (p.action === "open") {
          expect(p.dedupKey).toBe(key);
          expect(p.components.every((c) => names.has(c.componentId))).toBe(true);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});
