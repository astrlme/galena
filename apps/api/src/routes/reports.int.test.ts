import type { IncidentId, MonitorId } from "@galena/contracts";
import type { MonthOf } from "@galena/core";
import { schema } from "@galena/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp, type Deps } from "../app.ts";
import { testDeps } from "../test-deps.ts";
import { Session } from "../test-session.ts";

let container: StartedPostgreSqlContainer | undefined;
let close: (() => Promise<void>) | undefined;
let deps: Deps;
let months: Map<string, MonthOf>;
let owner: Session;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const built = testDeps(container.getConnectionUri());
  await built.migrate();
  deps = built.deps;
  months = built.months;
  close = built.close;
  owner = new Session(createApp(deps));
  const setup = await owner.call("/v1/setup", {
    workspaceName: "Acme",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
  });
  expect(setup.status).toBe(201);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const created = async (path: string, body: unknown) => {
  const response = await owner.call(path, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

test("a past month's report counts each monitor's and component's minutes, incidents and budget", async () => {
  const checkout = (await created("/v1/monitors", {
    name: "Checkout",
    http: { url: "https://shop.example.com/" },
    slaTarget: 99.9,
  })) as MonitorId;
  const search = (await created("/v1/monitors", {
    name: "Search",
    http: { url: "https://search.example.com/" },
  })) as MonitorId;
  const api = await created("/v1/components", { name: "API" });
  const web = await created("/v1/components", { name: "Web" });
  months.set(`${checkout} 2026-10`, { minutes: 44_640, minutesDown: 12, p95Ms: 230 });

  const [ws] = await deps.db.select().from(schema.workspace);
  const workspaceId = ws?.id ?? expect.fail("no workspace");
  // API: 40 minutes of major outage on the 1st; the days either side of October don't count.
  await deps.db.insert(schema.uptimeDaily).values(
    [
      ["2026-09-30", { major_outage: 1440 }],
      ["2026-10-01", { operational: 1400, major_outage: 40 }],
      ["2026-10-31", { operational: 1380, under_maintenance: 60 }],
      ["2026-11-01", { major_outage: 1440 }],
    ].map(([day, minutes]) => ({
      id: v7(),
      workspaceId,
      componentId: api as never,
      day: day as string,
      minutes: minutes as Record<string, number>,
    })),
  );
  const id = v7() as IncidentId;
  await deps.db.insert(schema.incident).values({
    id,
    workspaceId,
    title: "Checkout is down",
    status: "resolved",
    impact: "major",
    source: "monitor",
    dedupKey: `mon:${checkout}`,
    startedAt: new Date("2026-10-01T10:00:00.000Z"),
    resolvedAt: new Date("2026-10-01T10:40:00.000Z"),
  });
  await deps.db.insert(schema.incidentComponent).values({
    id: v7(),
    workspaceId,
    incidentId: id,
    componentId: api as never,
    status: "major_outage",
  });

  const response = await owner.call("/v1/reports/uptime?month=2026-10");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    month: "2026-10",
    monitors: [
      {
        id: checkout,
        name: "Checkout",
        type: "http",
        minutes: 44_640,
        minutesDown: 12,
        incidents: 1,
        p95Ms: 230,
        slaTarget: 99.9,
        // October is over: 0.1% of its 44,640 minutes is 44, and 12 are spent.
        budget: { allowedMinutes: 44, leftMinutes: 32 },
      },
      {
        id: search,
        name: "Search",
        type: "http",
        minutes: 0,
        minutesDown: 0,
        incidents: 0,
        p95Ms: null,
        slaTarget: null,
        budget: null,
      },
    ],
    components: [
      { id: api, name: "API", minutes: 2880, minutesDown: 40, incidents: 1 },
      { id: web, name: "Web", minutes: 0, minutesDown: 0, incidents: 0 },
    ],
  });
  expect((await owner.call("/v1/reports/uptime?month=2026-13")).status).toBe(400);
});
