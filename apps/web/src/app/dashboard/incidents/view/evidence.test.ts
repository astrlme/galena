import { expect, test } from "vitest";
import {
  type Evidence,
  type IncidentDetail,
  regionRows,
  timelineOf,
  triggerOf,
} from "./evidence.ts";

const MONITOR = "01920000-0000-7000-8000-0000000000b1";
const minute = (hhmm: string) => `2026-11-08T${hhmm}:00.000Z`;
const timeout = { code: "timeout" as const, message: "No complete response within 10000 ms." };

const incident = (over: Partial<IncidentDetail> = {}): IncidentDetail => ({
  id: "01920000-0000-7000-8000-000000000042",
  title: "Checkout is not responding",
  status: "investigating",
  impact: "major",
  visibility: "draft",
  source: "monitor",
  startedAt: minute("10:02"),
  resolvedAt: null,
  updatedAt: minute("10:02"),
  components: [],
  approvalDeadline: minute("10:17"),
  updates: [
    {
      id: "01920000-0000-7000-8000-000000000053",
      status: "investigating",
      body: "We're seeing timeouts on Checkout.",
      createdAt: minute("10:02"),
    },
  ],
  ...over,
});

type Result = NonNullable<Evidence["monitor"]>["results"][number];
const up = (hhmm: string, region: string, ms = 120): Result => ({
  region,
  scheduledAt: minute(hhmm),
  status: "up",
  latencyMs: ms,
  error: null,
});
const down = (hhmm: string, region: string): Result => ({
  region,
  scheduledAt: minute(hhmm),
  status: "down",
  latencyMs: null,
  error: timeout,
});

/** Ireland and Paris fail from 10:00; Stockholm keeps answering. */
const evidence = (over: Partial<NonNullable<Evidence["monitor"]>> = {}): Evidence => ({
  monitor: {
    id: MONITOR,
    name: "Checkout",
    type: "http",
    regions: ["eu-west-1", "eu-west-3", "eu-north-1"],
    window: { from: minute("09:32"), to: minute("10:05"), gap: null },
    results: [
      up("09:58", "eu-west-1", 110),
      up("09:58", "eu-west-3", 130),
      up("09:58", "eu-north-1", 150),
      up("09:59", "eu-west-1", 120),
      up("09:59", "eu-west-3", 120),
      down("10:00", "eu-west-1"),
      down("10:00", "eu-west-3"),
      up("10:00", "eu-north-1", 160),
      down("10:01", "eu-west-1"),
      down("10:01", "eu-west-3"),
    ],
    transitions: [{ from: "up", to: "down", at: minute("10:02") }],
    ...over,
  },
  timeline: [],
  notifications: [],
});

test("says which regions failed, from when, why, and how fast it answered before", () => {
  expect(triggerOf(incident(), evidence())).toBe(
    "Checkout failed in 2 of 3 regions from 10:00 UTC: No complete response within 10000 ms. Before that it answered in 120 ms.",
  );
});

test("says when every region answers again", () => {
  const recovered = evidence();
  recovered.monitor?.results.push(up("10:02", "eu-west-1"), up("10:02", "eu-west-3"));
  expect(triggerOf(incident(), recovered)).toMatch(
    /^Checkout is answering again in every region\. It failed in 2 of 3 regions from 10:00 UTC/,
  );
});

test("names what opened an incident without checks", () => {
  const none: Evidence = { monitor: null, timeline: [], notifications: null };
  expect(triggerOf(incident({ source: "manual" }), none)).toBe(
    "Opened by a person, not a monitor.",
  );
  expect(triggerOf(incident(), none)).toBe("Opened by a monitor that has since been deleted.");
  expect(
    triggerOf(incident({ source: "signal" }), {
      ...none,
      timeline: [
        {
          kind: "signal",
          at: minute("10:02"),
          integrationId: "01920000-0000-7000-8000-0000000000c1",
          integrationName: "Production Alertmanager",
          title: "HighErrorRate",
          status: "firing",
          alerts: [{ alertname: "HighErrorRate" }],
          alertCount: 3,
        },
      ],
    }),
  ).toBe("Opened from an alert: HighErrorRate, 3 alerts, from Production Alertmanager.");
  expect(triggerOf(incident(), evidence({ results: [] }))).toBe(
    "Checkout has no check results from that time.",
  );
});

test("marks each region's minutes and says since when a failing one fails", () => {
  const rows = regionRows(evidence());
  expect(rows.map((r) => [r.region, r.failing, r.latest])).toEqual([
    ["eu-west-1", { since: minute("10:00"), message: timeout.message, mayBeOlder: false }, null],
    ["eu-west-3", { since: minute("10:00"), message: timeout.message, mayBeOlder: false }, null],
    ["eu-north-1", null, { ms: 160, isDegraded: false }],
  ]);
  const ireland = rows[0];
  // 09:32 to 10:05: 34 minutes, the last four of them 09:58 up, 09:59 up, 10:00 down, 10:01 down.
  expect(ireland?.head).toHaveLength(34);
  expect(ireland?.head.slice(26, 30)).toEqual([
    "operational",
    "operational",
    "major_outage",
    "major_outage",
  ]);
  expect(ireland?.tail).toBeNull();
});

test("a long incident's rows hold its first and latest minutes; a run past the gap may be older", () => {
  const rows = regionRows(
    evidence({
      window: {
        from: minute("06:00"),
        to: minute("10:00"),
        gap: { from: minute("07:00"), to: minute("09:00") },
      },
      results: [
        up("06:00", "eu-west-1"),
        down("06:59", "eu-west-1"),
        down("09:00", "eu-west-1"),
        up("06:00", "eu-west-3"),
        up("09:00", "eu-west-3"),
        down("09:01", "eu-west-3"),
      ],
    }),
  );
  expect(rows[0]?.head).toHaveLength(61);
  expect(rows[0]?.tail).toHaveLength(61);
  expect(rows.slice(0, 2).map((r) => [r.failing?.since, r.failing?.mayBeOlder])).toEqual([
    [minute("09:00"), true],
    [minute("09:01"), false],
  ]);
});

test("a heartbeat is judged in one region: one row, and its own words for why", () => {
  const missed = {
    code: "heartbeat_missed" as const,
    message: "No check-in since 8 Nov, 09:45 UTC; one was due by 10:00 UTC.",
  };
  const heartbeat = evidence({
    type: "heartbeat",
    results: [up("09:59", "eu-central-1"), { ...down("10:00", "eu-central-1"), error: missed }],
  });
  expect(regionRows(heartbeat).map((r) => r.region)).toEqual(["eu-central-1"]);
  expect(triggerOf(incident(), heartbeat)).toBe(
    "Checkout went down at 10:00 UTC: No check-in since 8 Nov, 09:45 UTC; one was due by 10:00 UTC.",
  );
  heartbeat.monitor?.results.push(up("10:03", "eu-central-1"));
  expect(triggerOf(incident(), heartbeat)).toMatch(
    /^Checkout is answering again in every region\. It went down at 10:00 UTC/,
  );
});

test("counts only the failures the incident opened on, and reads a probe error as no word", () => {
  const blips = evidence();
  // Stockholm failed once well before the start, and its probe erred since; it still answers.
  blips.monitor?.results.push(down("09:40", "eu-north-1"), {
    ...down("10:01", "eu-north-1"),
    status: "error",
    error: { code: "probe_failed", message: "The probe crashed." },
  });
  expect(triggerOf(incident(), blips)).toMatch(/^Checkout failed in 2 of 3 regions from 10:00 UTC/);
  expect(regionRows(blips)[2]?.latest).toEqual({ ms: 160, isDegraded: false });
});

test("a degraded region says so", () => {
  const slow = evidence();
  slow.monitor?.results.push({ ...up("10:01", "eu-north-1", 910), status: "degraded" });
  expect(regionRows(slow)[2]?.latest).toEqual({ ms: 910, isDegraded: true });
});

test("tells the story in time order: the monitor, alerts, updates and notices", () => {
  const entries = timelineOf(incident({ visibility: "published" }), {
    ...evidence(),
    timeline: [
      { kind: "status_changed", at: minute("10:02"), from: null, to: "investigating" },
      {
        kind: "signal",
        at: minute("10:03"),
        integrationId: "01920000-0000-7000-8000-0000000000c1",
        integrationName: null,
        title: "HighErrorRate",
        status: "firing",
        alerts: [{ alertname: "HighErrorRate", service: "checkout" }],
        alertCount: 1,
      },
    ],
    notifications: [
      {
        eventId: "01920000-0000-7000-8000-0000000000e1",
        at: minute("10:04"),
        subscribers: { pending: 0, sent: 2, failed: 1, skipped: 0 },
        endpoints: [
          {
            id: "01920000-0000-7000-8000-0000000000f1",
            name: "#incidents",
            kind: "slack",
            status: "failed",
            attempts: 3,
            lastError: "The endpoint answered HTTP 503.",
            sentAt: null,
          },
        ],
      },
    ],
  });
  expect(entries.map((e) => [e.at.slice(11, 16), e.text])).toEqual([
    ["10:00", "Ireland (eu-west-1) began failing"],
    ["10:00", "Paris (eu-west-3) began failing"],
    ["10:02", "Checkout is down"],
    ["10:02", "Update posted: Investigating"],
    ["10:03", "Alert from a deleted integration: HighErrorRate firing, 1 alert"],
    ["10:04", "Notice sent: 2 of 3 subscriber emails delivered, 1 failed. #incidents failed."],
  ]);
  expect(entries[0]?.detail).toBe(timeout.message);
  expect(entries[3]?.detail).toBe("We're seeing timeouts on Checkout.");
  expect(entries[4]?.labels).toEqual([{ alertname: "HighErrorRate", service: "checkout" }]);
  expect(entries[5]?.detail).toBe("#incidents: The endpoint answered HTTP 503.");
});

test("a draft's text is written, not posted", () => {
  const entries = timelineOf(incident(), evidence());
  expect(entries.map((e) => e.text)).toContain("Draft written: Investigating");
});
