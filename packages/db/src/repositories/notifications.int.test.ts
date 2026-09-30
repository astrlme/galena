import { componentId, eventId, incidentId, subscriberId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { workspace } from "../schema/index.ts";
import {
  countSubscribersFromIp,
  findDelivery,
  findSubscriber,
  findSubscriberByEmail,
  listActiveSubscribers,
  recordDeliveries,
  saveSubscriber,
  setSubscriberState,
  settleDelivery,
  suppressSubscriber,
  wasAnnounced,
} from "./notifications.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const api = componentId.parse(v7());

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(workspace).values({ id: acme, name: "Acme" });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const at = (iso: string) => new Date(iso);
const newSubscriber = (email: string) => ({
  id: subscriberId.parse(v7()),
  workspaceId: acme,
  email,
  state: "pending_confirmation" as const,
  componentIds: [api],
  confirmSentAt: at("2026-09-30T12:00:00Z"),
  ipHash: "ip-1",
});

test("an address is stored once; asking again updates the same row", async () => {
  const first = newSubscriber("ada@example.com");
  expect(await saveSubscriber(db, first)).toBe(first.id);
  const again = { ...newSubscriber("ada@example.com"), componentIds: [] };
  expect(await saveSubscriber(db, again)).toBe(first.id);
  expect(await findSubscriberByEmail(db, acme, "ada@example.com")).toMatchObject({
    id: first.id,
    componentIds: [],
  });
  expect(await countSubscribersFromIp(db, "ip-1", at("2026-01-01T00:00:00Z"))).toBe(1);
});

test("only active subscribers hear about events, and a bounce suppresses the address", async () => {
  const grace = newSubscriber("grace@example.com");
  await saveSubscriber(db, grace);
  expect((await listActiveSubscribers(db, acme)).map((s) => s.id)).not.toContain(grace.id);

  await setSubscriberState(db, grace.id, "active", at("2026-09-30T12:05:00Z"));
  expect(await listActiveSubscribers(db, acme)).toContainEqual({
    id: grace.id,
    componentIds: [api],
  });

  expect(await suppressSubscriber(db, "grace@example.com")).toBe(1);
  expect((await findSubscriber(db, grace.id))?.state).toBe("suppressed");
  expect((await listActiveSubscribers(db, acme)).map((s) => s.id)).not.toContain(grace.id);
});

test("recording the same deliveries twice keeps one row each, and a row settles once", async () => {
  const linus = newSubscriber("linus@example.com");
  await saveSubscriber(db, linus);
  const event = {
    workspaceId: acme,
    eventId: eventId.parse(v7()),
    subjectId: incidentId.parse(v7()),
  };
  const target = { subscriberId: linus.id, channel: "email" as const };
  await recordDeliveries(db, event, [target]);
  await recordDeliveries(db, event, [target]);

  const row = await findDelivery(db, event.eventId, { subscriberId: linus.id });
  expect(row).toMatchObject({ status: "pending", attempts: 0 });
  if (!row) throw new Error("no delivery");
  const sent = { status: "sent" as const, attempts: 1, providerId: "ses-1", sentAt: new Date() };
  expect(await settleDelivery(db, row.id, sent)).toBe(true);
  // A retried send of the same delivery finds it settled.
  expect(await settleDelivery(db, row.id, sent)).toBe(false);

  const later = eventId.parse(v7());
  expect(await wasAnnounced(db, acme, event.subjectId, event.eventId)).toBe(false);
  expect(await wasAnnounced(db, acme, event.subjectId, later)).toBe(true);
});

test("a delivery names exactly one target", async () => {
  const event = {
    workspaceId: acme,
    eventId: eventId.parse(v7()),
    subjectId: incidentId.parse(v7()),
  };
  await expect(recordDeliveries(db, event, [{ channel: "email" } as never])).rejects.toThrow();
});
