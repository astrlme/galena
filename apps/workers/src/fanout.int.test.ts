import {
  componentId,
  eventId,
  incidentId,
  incidentUpdateId,
  maintenanceId,
  subscriberId,
  webhookEndpointId,
  workspaceId,
} from "@galena/contracts";
import {
  createDb,
  createEndpoint,
  type Db,
  incidentRepository,
  maintenanceRepository,
  saveSubscriber,
  schema,
} from "@galena/db";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type OutgoingEmail, sendEmail } from "./email.ts";
import { type FanoutEvent, fanOut } from "./fanout.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const api = componentId.parse(v7());
const web = componentId.parse(v7());
const url = "https://status.example.com";
const now = new Date("2026-09-30T12:00:00.000Z");
const subscribers = {
  everything: subscriberId.parse(v7()),
  apiOnly: subscriberId.parse(v7()),
  webOnly: subscriberId.parse(v7()),
  pending: subscriberId.parse(v7()),
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
  await db.insert(schema.component).values([
    { id: api, workspaceId: acme, name: "API", position: 0 },
    { id: web, workspaceId: acme, name: "Web", position: 1 },
  ]);
  for (const [name, id] of Object.entries(subscribers)) {
    await saveSubscriber(db, {
      id,
      workspaceId: acme,
      email: `${name}@example.com`,
      state: name === "pending" ? "pending_confirmation" : "active",
      componentIds: name === "apiOnly" ? [api] : name === "webOnly" ? [web] : [],
      confirmSentAt: now,
      ipHash: null,
    });
  }
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

/** Fans out, then sends every request the way notify.email would, into one inbox. */
function pipeline() {
  const inbox: OutgoingEmail[] = [];
  const mailer = {
    send: async (e: OutgoingEmail) => {
      inbox.push(e);
      return { id: `ses-${inbox.length}` };
    },
  };
  const run = (event: FanoutEvent) =>
    fanOut(event, {
      db,
      url,
      sendToEndpoints: async () => {},
      sendEmails: async (requests) => {
        for (const { subscriberId: id, notice } of requests) {
          await sendEmail(
            { kind: "notice", subscriberId: id, notice },
            { db, url, mailer, keys: appKeys(LOCAL_APP_KEY), now: () => now },
          );
        }
      },
    });
  return { inbox, run };
}

const openIncident = async (visibility: "published" | "internal") => {
  const id = incidentId.parse(v7());
  await incidentRepository(db).create(
    {
      id,
      workspaceId: acme,
      title: "Errors on API",
      impact: "major",
      visibility,
      source: "manual",
      startedAt: now,
    },
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "investigating",
        body: "Looking into it.",
        createdAt: now,
        createdByUserId: null,
      },
      stage: { status: "investigating", resolvedAt: null },
      components: [{ componentId: api, status: "partial_outage" }],
    },
  );
  return {
    id: eventId.parse(v7()),
    workspaceId: acme,
    occurredAt: now.toISOString(),
    type: "incident.created" as const,
    data: {
      incidentId: id,
      status: "investigating" as const,
      impact: "major" as const,
      visibility,
    },
  };
};

test("an incident reaches everyone following its components, once, however often it runs", async () => {
  const { inbox, run } = pipeline();
  const event = await openIncident("published");
  expect(await run(event)).toEqual({ outcome: "fanned_out", targets: 2 });
  expect(await run(event)).toEqual({ outcome: "fanned_out", targets: 2 });
  expect(inbox.map((e) => e.to).sort()).toEqual(["apiOnly@example.com", "everything@example.com"]);
  expect(inbox[0]?.subject).toBe("▲︎ Partial outage: API");
});

test("an internal incident reaches nobody", async () => {
  const { inbox, run } = pipeline();
  expect(await run(await openIncident("internal"))).toEqual({ outcome: "not_notified" });
  expect(inbox).toEqual([]);
});

test("a window is announced when scheduled, not again on every edit", async () => {
  const { inbox, run } = pipeline();
  const id = maintenanceId.parse(v7());
  const window = {
    id,
    workspaceId: acme,
    title: "Database upgrade",
    body: "Writes pause for up to 5 minutes.",
    status: "scheduled" as const,
    startsAt: new Date("2026-10-01T22:00:00Z"),
    endsAt: new Date("2026-10-01T23:00:00Z"),
    version: 1,
    cancelledAt: null,
    componentIds: [web],
  };
  await maintenanceRepository(db).save(window, null);
  const scheduled = (version: number) => ({
    id: eventId.parse(v7()),
    workspaceId: acme,
    occurredAt: now.toISOString(),
    type: "maintenance.scheduled" as const,
    data: { maintenanceId: id, version, status: "scheduled" as const },
  });
  expect(await run(scheduled(1))).toEqual({ outcome: "fanned_out", targets: 2 });
  expect(await run(scheduled(2))).toEqual({ outcome: "not_notified" });
  expect(inbox.map((e) => e.to).sort()).toEqual(["everything@example.com", "webOnly@example.com"]);
  expect(inbox[0]?.subject).toBe("◌︎ Maintenance scheduled: Database upgrade");
});

test("endpoints following the event's components get one delivery each, like subscribers", async () => {
  const everything = webhookEndpointId.parse(v7());
  const webOnly = webhookEndpointId.parse(v7());
  for (const [id, componentIds] of [
    [everything, []],
    [webOnly, [web]],
  ] as const) {
    await createEndpoint(db, {
      id,
      workspaceId: acme,
      kind: "webhook",
      name: id,
      componentIds: [...componentIds],
      urlSealed: "v1.a.b",
      secretSealed: "v1.c.d",
    });
  }
  const requested: string[] = [];
  const event = await openIncident("published");
  for (let i = 0; i < 2; i++) {
    await fanOut(event, {
      db,
      url,
      sendEmails: async () => {},
      sendToEndpoints: async (requests) => {
        requested.push(...requests.map((r) => `${r.kind}:${r.endpointId}`));
      },
    });
  }
  // Asked twice (the re-run), for the one endpoint that follows API; one delivery row.
  expect(requested).toEqual([`webhook:${everything}`, `webhook:${everything}`]);
  const rows = await db.select().from(schema.delivery);
  expect(rows.filter((r) => r.endpointId === everything && r.eventId === event.id)).toHaveLength(1);
  expect(rows.some((r) => r.endpointId === webOnly)).toBe(false);
});
