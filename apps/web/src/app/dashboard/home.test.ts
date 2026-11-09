import { expect, test } from "vitest";
import { activityOf, type HomeData, needsOf } from "./home.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const id = (n: number) => `01920000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];

type Incident = HomeData["incidents"][number];
type Monitor = HomeData["monitors"][number];
type Reading = HomeData["readings"][number];

const incident = (n: number, over: Partial<Incident> = {}): Incident => ({
  id: id(n),
  title: `Incident ${n}`,
  status: "investigating",
  impact: "major",
  visibility: "published",
  source: "manual",
  startedAt: ago(40),
  resolvedAt: null,
  updatedAt: ago(5),
  components: [],
  approvalDeadline: null,
  monitorId: null,
  ...over,
});

const monitor = (n: number, name: string): Monitor => ({
  id: id(n),
  componentId: null,
  name,
  type: "http",
  http: {
    url: `https://${name.toLowerCase()}.example.com/`,
    method: "GET",
    timeoutMs: 10_000,
    followRedirects: true,
  },
  heartbeat: null,
  publishPolicy: "approve",
  downStatus: "major_outage",
  detection: {
    failThreshold: 2,
    recoverThreshold: 3,
    quorum: 2,
    degradedLatencyMs: null,
    staleAfterIntervals: 3,
    flapWindowMinutes: 30,
    flapMaxTransitions: 4,
    stableMinutes: 15,
    recoverAtOnce: false,
  },
  enabled: true,
});

/** Down for `minutes` in `failing` regions, answering in the others. */
const reading = (n: number, state: Reading["state"], minutes = 0, failing = REGIONS): Reading => ({
  id: id(n),
  state,
  status: state === "down" ? "major_outage" : "operational",
  since: ago(minutes),
  results: REGIONS.map((region) => ({
    region,
    scheduledAt: ago(0),
    status: state === "down" && failing.includes(region) ? "down" : "up",
    latencyMs: state === "down" && failing.includes(region) ? null : 120,
  })),
  summary: null,
  lastPingAt: null,
});

/** One of every kind, listed out of order. */
const everything: HomeData = {
  now: NOW,
  incidents: [
    // Published 45 minutes ago and never updated since: stale.
    incident(0x41, { title: "Search is slow", updatedAt: ago(45) }),
    // Updated 10 minutes ago: not stale.
    incident(0x42, { title: "Billing is degraded", updatedAt: ago(10) }),
    // A draft from the Checkout monitor, which is down: the monitor folds into it.
    incident(0x43, {
      title: "Checkout is not responding",
      visibility: "draft",
      source: "monitor",
      monitorId: id(0x31),
      approvalDeadline: new Date(NOW + 9 * 60_000).toISOString(),
    }),
    // The API monitor's published incident, updated just now: the monitor waits until it's stale.
    incident(0x44, {
      title: "API errors",
      source: "monitor",
      monitorId: id(0x32),
      updatedAt: ago(2),
    }),
  ],
  monitors: [
    monitor(0x31, "Checkout"),
    monitor(0x32, "API"),
    monitor(0x33, "Webhooks"),
    monitor(0x34, "Website"),
  ],
  readings: [
    reading(0x31, "down", 4),
    reading(0x32, "down", 20),
    // Down in 2 of 3 regions, with no incident: listed.
    reading(0x33, "down", 12, ["eu-west-1", "eu-west-3"]),
    reading(0x34, "up", 600),
  ],
  endpoints: [
    {
      id: id(0x81),
      kind: "webhook",
      name: "On-call bridge",
      state: "failing",
      componentIds: [],
      failingSince: ago(95),
      createdAt: ago(10_000),
    },
    {
      id: id(0x82),
      kind: "slack",
      name: "#incidents",
      state: "active",
      componentIds: [],
      failingSince: null,
      createdAt: ago(10_000),
    },
  ],
  expiries: [
    {
      kind: "certificate",
      name: "checkout.example.com",
      expiresAt: new Date(NOW + 9 * 86_400_000).toISOString(),
      issuer: "Let's Encrypt",
      monitorIds: [id(0x31)],
      checkedAt: ago(30),
    },
    // 60 days out: not soon.
    {
      kind: "domain",
      name: "example.com",
      expiresAt: new Date(NOW + 60 * 86_400_000).toISOString(),
      issuer: null,
      monitorIds: [id(0x31)],
      checkedAt: ago(30),
    },
  ],
  resolved: [],
};

test("lists drafts, down monitors, failing destinations, expiring certificates, then stale incidents", () => {
  expect(needsOf(everything).map((n) => [n.kind, n.title])).toEqual([
    ["draft", "Checkout is not responding"],
    ["down", "Webhooks is down in 2 of 3 regions"],
    ["destination", "On-call bridge isn't receiving notifications"],
    ["expiry", "Certificate for checkout.example.com expires in 9 days"],
    ["stale", "Search is slow"],
  ]);
});

test("each item leads to the place its work is done, never approving on Home", () => {
  const [draft, down, destination, expiry, stale] = needsOf(everything);
  expect(draft?.action).toEqual({
    label: "Review draft",
    href: `/dashboard/incidents/view/?id=${id(0x43)}`,
  });
  expect(down?.action.href).toBe(`/dashboard/monitors/view/?id=${id(0x33)}`);
  expect(destination?.action.href).toBe("/dashboard/status-page/subscribers/");
  expect(expiry?.action.href).toBe(`/dashboard/monitors/view/?id=${id(0x31)}`);
  expect(stale?.action).toEqual({
    label: "Post update",
    href: `/dashboard/incidents/view/?id=${id(0x41)}`,
  });
});

test("flags an incident once 30 minutes pass without an update", () => {
  const at = (minutes: number) =>
    needsOf({ ...everything, incidents: [incident(0x41, { updatedAt: ago(minutes) })] }).filter(
      (n) => n.kind === "stale",
    ).length;
  expect(at(29)).toBe(0);
  expect(at(30)).toBe(1);
});

test("a down monitor joins the list once its published incident goes stale, in its own slot", () => {
  const stale = needsOf({
    ...everything,
    incidents: [incident(0x44, { title: "API errors", monitorId: id(0x32), updatedAt: ago(31) })],
  });
  const api = stale.filter((n) => n.title === "API errors" || n.title.startsWith("API"));
  expect(api.map((n) => [n.kind, n.title])).toEqual([["down", "API is down in 3 of 3 regions"]]);
  expect(api[0]?.detail).toContain('"API errors" was last updated 31 min ago.');
  expect(api[0]?.action).toEqual({
    label: "Post update",
    href: `/dashboard/incidents/view/?id=${id(0x44)}`,
  });
});

test("a down monitor says so when someone else's incident is open on its component", () => {
  const webhooks = { ...monitor(0x33, "Webhooks"), componentId: id(0x25) };
  const needs = needsOf({
    ...everything,
    monitors: [webhooks],
    incidents: [
      incident(0x46, {
        title: "Webhooks delayed",
        components: [{ componentId: id(0x25), status: "degraded_performance" }],
      }),
    ],
  });
  expect(needs.find((n) => n.kind === "down")?.detail).toContain(
    '"Webhooks delayed" is open on its component.',
  );
});

test("a member who can't see destinations isn't told about them", () => {
  expect(needsOf({ ...everything, endpoints: null }).map((n) => n.kind)).not.toContain(
    "destination",
  );
});

test("nothing needs you when all is well", () => {
  expect(
    needsOf({
      ...everything,
      incidents: [],
      readings: everything.readings.map((r) => ({ ...r, state: "up" as const })),
      endpoints: [],
      expiries: [],
    }),
  ).toEqual([]);
});

test("recent activity reads newest first", () => {
  const activity = activityOf({
    ...everything,
    resolved: [incident(0x45, { title: "Login errors", resolvedAt: ago(1), updatedAt: ago(1) })],
  });
  expect(activity.slice(0, 3).map((a) => a.text)).toEqual([
    "Login errors resolved",
    "API errors updated",
    "Checkout went down",
  ]);
});
