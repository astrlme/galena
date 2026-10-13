import { componentId, integrationId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { workspace } from "../schema/index.ts";
import {
  createIntegration,
  deleteIntegration,
  findIntegration,
  listIntegrations,
  recordSignalOutcome,
  setIntegrationToken,
  updateIntegration,
} from "./integrations.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());
const api = componentId.parse(v7());
const issued = new Date("2026-10-13T09:00:00Z");

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
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

test("an integration keeps its routes in order and changes only in its own workspace", async () => {
  const id = integrationId.parse(v7());
  const routes = [
    { match: { service: "api" }, componentIds: [api], downStatus: "partial_outage" as const },
    { match: {}, componentIds: [api], downStatus: "major_outage" as const },
  ];
  await createIntegration(db, {
    id,
    workspaceId: acme,
    source: "alertmanager",
    name: "Prometheus",
    publishPolicy: "approve",
    routes,
    tokenIssuedAt: issued,
  });
  expect(await findIntegration(db, id)).toMatchObject({
    workspaceId: acme,
    source: "alertmanager",
    routes,
    tokenIssuedAt: issued,
    lastSignalAt: null,
    lastOutcome: null,
  });

  expect(
    await updateIntegration(db, other, id, { name: "X", publishPolicy: "auto", routes: [] }),
  ).toBe(false);
  expect(
    await updateIntegration(db, acme, id, { name: "Prom", publishPolicy: "auto", routes: [] }),
  ).toBe(true);
  const later = new Date("2026-10-13T11:00:00Z");
  expect(await setIntegrationToken(db, acme, id, later)).toBe(true);
  await recordSignalOutcome(db, id, "no_route", later);
  expect(await listIntegrations(db, acme)).toEqual([
    expect.objectContaining({
      name: "Prom",
      publishPolicy: "auto",
      routes: [],
      tokenIssuedAt: later,
      lastSignalAt: later,
      lastOutcome: "no_route",
    }),
  ]);
  expect(await listIntegrations(db, other)).toEqual([]);

  expect(await deleteIntegration(db, other, id)).toBe(false);
  expect(await deleteIntegration(db, acme, id)).toBe(true);
  expect(await findIntegration(db, id)).toBeUndefined();
});
