import type { paths } from "../api-schema.ts";

/** The JSON a GET on `path` answers with, from the API's own schema. */
export type Answer<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer T } } } };
}
  ? T
  : never;
type Monitor = Answer<"/v1/monitors">["monitors"][number];
type Reading = Answer<"/v1/monitors/telemetry">["monitors"][number];
type Incident = Answer<"/v1/incidents/{id}">;
type Subscriber = Answer<"/v1/subscribers">[number];

const MINUTE = 60_000;
const REGIONS = ["eu-west-1", "eu-west-3", "eu-north-1"];
const id = (n: number) => `01920000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const group = { core: id(0x11), integrations: id(0x12) };
const component = {
  website: id(0x21),
  api: id(0x22),
  dashboard: id(0x23),
  checkout: id(0x24),
  webhooks: id(0x25),
  email: id(0x26),
};
const DETECTION = {
  failThreshold: 2,
  recoverThreshold: 3,
  quorum: 2,
  degradedLatencyMs: null,
  staleAfterIntervals: 3,
  flapWindowMinutes: 30,
  flapMaxTransitions: 4,
  stableMinutes: 15,
};

/** What each monitor did over the last hour: which regions failed, and for how many minutes. */
const scenes = [
  { n: 0x31, name: "Website", url: "https://acme.example.com/", on: component.website, ms: 120 },
  {
    n: 0x32,
    name: "API health",
    url: "https://api.acme.example.com/health",
    on: component.api,
    ms: 85,
    // Two of three regions see errors: enough for a quorum.
    down: { regions: ["eu-west-1", "eu-west-3"], from: 26, to: 0 },
    downStatus: "partial_outage" as const,
  },
  {
    n: 0x33,
    name: "Dashboard",
    url: "https://app.acme.example.com/",
    on: component.dashboard,
    ms: 210,
  },
  {
    n: 0x34,
    name: "Checkout",
    url: "https://acme.example.com/checkout",
    on: component.checkout,
    ms: 160,
    down: { regions: REGIONS, from: 4, to: 0 },
  },
  {
    n: 0x35,
    name: "Webhook delivery",
    url: "https://hooks.acme.example.com/health",
    on: component.webhooks,
    ms: 95,
    // Back up for a few minutes: recovering until it has been stable for 15.
    down: { regions: REGIONS, from: 41, to: 7 },
  },
  {
    n: 0x36,
    name: "Email",
    url: "https://mail.acme.example.com/health",
    on: component.email,
    ms: 70,
  },
];

/** A whole sample workspace, its times relative to `now` so it never looks stale. */
export function demoData(now: Date) {
  const minute = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const at = (minutesAgo: number) => new Date(minute - minutesAgo * MINUTE).toISOString();
  const utc = (minutesAgo: number) => `${at(minutesAgo).slice(11, 16)} UTC`;

  const monitors: Monitor[] = scenes.map((s) => ({
    id: id(s.n),
    componentId: s.on,
    name: s.name,
    type: "http",
    http: { url: s.url, method: "GET", timeoutMs: 10_000, followRedirects: true },
    publishPolicy: "approve",
    downStatus: s.downStatus ?? "major_outage",
    detection: DETECTION,
    enabled: true,
  }));

  const telemetry: Reading[] = scenes.map((s) => {
    const failing = (ago: number, region: string) =>
      !!s.down && ago <= s.down.from && ago >= s.down.to && s.down.regions.includes(region);
    const results = Array.from({ length: 60 }, (_, ago) =>
      REGIONS.map((region, r) => {
        const down = failing(ago, region);
        return {
          region,
          scheduledAt: at(ago),
          status: down ? ("down" as const) : ("up" as const),
          // A steady wobble, the same on every load.
          latencyMs: down ? null : s.ms + r * 14 + ((ago * 37 + r * 11) % 23),
        };
      }),
    ).flat();
    const state = !s.down ? "up" : s.down.to === 0 ? "down" : "recovering";
    return {
      id: id(s.n),
      state,
      // Recovering counts as operational; its incident waits in monitoring until stable.
      status: state === "down" ? (s.downStatus ?? "major_outage") : "operational",
      since: at(s.down ? s.down.to || s.down.from : 60 * 24 * 9),
      results,
    };
  });

  const incidents: Incident[] = [
    {
      id: id(0x41),
      title: "Elevated errors on the API",
      status: "identified",
      impact: "major",
      visibility: "published",
      source: "monitor",
      startedAt: at(25),
      resolvedAt: null,
      updatedAt: at(10),
      components: [{ componentId: component.api, status: "partial_outage" }],
      approvalDeadline: null,
      updates: [
        {
          id: id(0x51),
          status: "identified",
          body: `We found the cause: a configuration change on the load balancer. We're rolling it back. Next update by ${utc(-20)}.`,
          createdAt: at(10),
        },
        {
          id: id(0x52),
          status: "investigating",
          body: `We're seeing errors on API from eu-west-1 and eu-west-3. We're investigating and will update by ${utc(-6)}.`,
          createdAt: at(24),
        },
      ],
    },
    {
      id: id(0x42),
      title: "Checkout is not responding",
      status: "investigating",
      impact: "major",
      visibility: "draft",
      source: "monitor",
      startedAt: at(3),
      resolvedAt: null,
      updatedAt: at(3),
      components: [{ componentId: component.checkout, status: "major_outage" }],
      approvalDeadline: at(-12),
      updates: [
        {
          id: id(0x53),
          status: "investigating",
          body: `We're seeing timeouts on Checkout from 3 regions. We're investigating and will update by ${utc(-27)}.`,
          createdAt: at(3),
        },
      ],
    },
    {
      id: id(0x45),
      title: "Webhook delivery is down",
      status: "monitoring",
      impact: "major",
      visibility: "published",
      source: "monitor",
      startedAt: at(40),
      resolvedAt: null,
      updatedAt: at(6),
      components: [{ componentId: component.webhooks, status: "operational" }],
      approvalDeadline: null,
      updates: [
        {
          id: id(0x59),
          status: "monitoring",
          body: "Webhooks is working normally again. We're watching it for the next 15 minutes.",
          createdAt: at(6),
        },
        {
          id: id(0x5a),
          status: "investigating",
          body: `We're seeing errors on Webhooks from 3 regions. We're investigating and will update by ${utc(10)}.`,
          createdAt: at(40),
        },
      ],
    },
    {
      id: id(0x43),
      title: "Slow dashboard",
      status: "resolved",
      impact: "minor",
      visibility: "published",
      source: "manual",
      startedAt: at(60 * 24 * 3 + 50),
      resolvedAt: at(60 * 24 * 3),
      updatedAt: at(60 * 24 * 3),
      components: [{ componentId: component.dashboard, status: "degraded_performance" }],
      approvalDeadline: null,
      updates: [
        {
          id: id(0x54),
          status: "resolved",
          body: `Dashboard has worked normally since ${utc(60 * 24 * 3 + 15)}. Pages load at their usual speed.`,
          createdAt: at(60 * 24 * 3),
        },
        {
          id: id(0x55),
          status: "monitoring",
          body: "Dashboard is working normally again. We're watching it for the next 15 minutes.",
          createdAt: at(60 * 24 * 3 + 20),
        },
        {
          id: id(0x56),
          status: "investigating",
          body: `We're seeing slow page loads on Dashboard from 3 regions. We're investigating and will update by ${utc(60 * 24 * 3 + 20)}.`,
          createdAt: at(60 * 24 * 3 + 50),
        },
      ],
    },
    {
      id: id(0x44),
      title: "Webhook deliveries delayed",
      status: "resolved",
      impact: "minor",
      visibility: "published",
      source: "monitor",
      startedAt: at(60 * 24 * 9 + 35),
      resolvedAt: at(60 * 24 * 9),
      updatedAt: at(60 * 24 * 9),
      components: [{ componentId: component.webhooks, status: "degraded_performance" }],
      approvalDeadline: null,
      updates: [
        {
          id: id(0x57),
          status: "resolved",
          body: `Webhooks has worked normally since ${utc(60 * 24 * 9 + 5)}. Every delayed delivery went out.`,
          createdAt: at(60 * 24 * 9),
        },
        {
          id: id(0x58),
          status: "investigating",
          body: `We're seeing deliveries up to 10 minutes late on Webhooks. We're investigating and will update by ${utc(60 * 24 * 9 + 5)}.`,
          createdAt: at(60 * 24 * 9 + 35),
        },
      ],
    },
  ];

  const status = (componentId: string) =>
    incidents
      .find((i) => i.visibility === "published" && i.resolvedAt === null)
      ?.components.find((c) => c.componentId === componentId)?.status ?? "operational";

  let position = 0;
  const item = (cid: string, groupId: string | null, name: string, description: string | null) => ({
    id: cid,
    groupId,
    name,
    description,
    position: position++,
    status: status(cid),
  });
  const subscriber = (
    k: number,
    email: string,
    state: Subscriber["state"],
    componentIds: string[] = [],
  ) => ({
    id: id(0x71 + k),
    email,
    state,
    componentIds,
    createdAt: at(60 * 24 * (12 - k * 3)),
  });

  return {
    me: {
      userId: id(0x01),
      email: "owner@example.com",
      role: "owner",
      workspaceId: id(0x02),
    } satisfies Answer<"/v1/me">,
    session: {
      session: { id: id(0x03) },
      user: { email: "owner@example.com", twoFactorEnabled: true },
    },
    sessions: [
      {
        id: id(0x03),
        token: "demo",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36",
        createdAt: at(60 * 5),
      },
    ],
    components: {
      groups: [
        { id: group.core, name: "Core", position: 0 },
        { id: group.integrations, name: "Integrations", position: 1 },
      ],
      components: [
        item(component.website, null, "Website", "acme.example.com"),
        item(component.api, group.core, "API", "Public REST API"),
        item(component.dashboard, group.core, "Dashboard", null),
        item(component.checkout, group.core, "Checkout", null),
        item(component.webhooks, group.integrations, "Webhooks", null),
        item(component.email, group.integrations, "Email", "Receipts and notifications"),
      ],
    } satisfies Answer<"/v1/components">,
    monitors: { monitors } satisfies Answer<"/v1/monitors">,
    telemetry: { regions: REGIONS, monitors: telemetry } satisfies Answer<"/v1/monitors/telemetry">,
    incidents,
    maintenances: {
      maintenances: [
        {
          id: id(0x61),
          title: "Database upgrade",
          body: "Writes pause for up to 5 minutes while the database restarts.",
          status: "scheduled",
          startsAt: at(-60 * 24 * 2),
          endsAt: at(-60 * 24 * 2 - 60),
          cancelledAt: null,
          componentIds: [component.api, component.dashboard],
        },
        {
          id: id(0x62),
          title: "Certificate rotation",
          body: "Connections may reset once.",
          status: "completed",
          startsAt: at(60 * 24 * 5 + 30),
          endsAt: at(60 * 24 * 5),
          cancelledAt: null,
          componentIds: [component.website],
        },
      ],
    } satisfies Answer<"/v1/maintenances">,
    subscribers: [
      subscriber(0, "a***@example.com", "active"),
      subscriber(1, "j***@example.org", "active", [component.api, component.checkout]),
      subscriber(2, "m***@example.net", "pending_confirmation"),
      subscriber(3, "s***@example.com", "unsubscribed"),
    ] satisfies Answer<"/v1/subscribers">,
    slack: {
      available: true,
      connection: { teamName: "Acme", channelName: "#incidents", connectedAt: at(60 * 24 * 20) },
    } satisfies Answer<"/v1/slack">,
    webhookEndpoints: [
      {
        id: id(0x81),
        kind: "slack",
        name: "#incidents",
        state: "active",
        componentIds: [],
        failingSince: null,
        createdAt: at(60 * 24 * 20),
      },
      {
        id: id(0x82),
        kind: "webhook",
        name: "On-call bridge",
        state: "failing",
        componentIds: [component.api],
        failingSince: at(95),
        createdAt: at(60 * 24 * 14),
      },
    ] satisfies Answer<"/v1/webhook-endpoints">,
  };
}
