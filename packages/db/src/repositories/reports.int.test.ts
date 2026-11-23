import { componentId, incidentId, type MonitorId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { component, incident, incidentComponent, workspace } from "../schema/index.ts";
import { monthIncidentCounts } from "./reports.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());
const api = componentId.parse(v7());
const web = componentId.parse(v7());
const watched = v7() as MonitorId;
const quiet = v7() as MonitorId;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values([
    { id: acme, name: "Acme" },
    { id: other, name: "Other" },
  ]);
  await db.insert(component).values([
    { id: api, workspaceId: acme, name: "API", position: 0 },
    { id: web, workspaceId: acme, name: "Web", position: 1 },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

async function add(
  startedAt: string,
  extra: { monitor?: MonitorId; components?: string[]; workspace?: string } & Record<
    string,
    unknown
  > = {},
) {
  const { monitor, components = [], workspace: ws = acme, ...fields } = extra;
  const id = incidentId.parse(v7());
  await db.insert(incident).values({
    id,
    workspaceId: ws as typeof acme,
    title: "Down",
    status: "resolved",
    impact: "major",
    source: monitor ? "monitor" : "manual",
    dedupKey: monitor ? `mon:${monitor}` : null,
    startedAt: new Date(startedAt),
    // Resolved: a monitor has one open incident at a time.
    resolvedAt: new Date(Date.parse(startedAt) + 3_600_000),
    ...fields,
  });
  if (components.length > 0) {
    await db.insert(incidentComponent).values(
      components.map((c) => ({
        id: v7(),
        workspaceId: ws as typeof acme,
        incidentId: id,
        componentId: c as typeof api,
        status: "major_outage" as const,
      })),
    );
  }
}

test("counts a month's incidents by the monitor that opened them and by published component", async () => {
  await add("2026-10-01T00:00:00.000Z", { monitor: watched, components: [api, web] });
  await add("2026-10-31T23:59:00.000Z", { monitor: watched, visibility: "internal" });
  await add("2026-10-12T08:00:00.000Z", { components: [api] });
  // Not counted for the monitor or the page: dismissed, deleted, before and after October.
  await add("2026-10-10T10:00:00.000Z", { monitor: watched, visibility: "dismissed" });
  await add("2026-10-11T10:00:00.000Z", {
    monitor: quiet,
    deletedAt: new Date(),
    components: [web],
  });
  await add("2026-09-30T23:59:00.000Z", { monitor: watched, components: [api] });
  await add("2026-11-01T00:00:00.000Z", { monitor: quiet, components: [api] });
  // A draft counts for its monitor, but the page never showed it.
  await add("2026-10-20T10:00:00.000Z", { monitor: quiet, visibility: "draft", components: [web] });

  const counts = await monthIncidentCounts(db, acme, {
    from: new Date("2026-10-01T00:00:00.000Z"),
    to: new Date("2026-11-01T00:00:00.000Z"),
  });
  expect(counts.monitors).toEqual(
    new Map([
      [watched, 2],
      [quiet, 1],
    ]),
  );
  expect(counts.components).toEqual(
    new Map([
      [api, 2],
      [web, 1],
    ]),
  );
  const elsewhere = await monthIncidentCounts(db, other, {
    from: new Date("2026-10-01T00:00:00.000Z"),
    to: new Date("2026-11-01T00:00:00.000Z"),
  });
  expect(elsewhere.monitors.size + elsewhere.components.size).toBe(0);
});
