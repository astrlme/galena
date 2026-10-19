import {
  componentId,
  eventId,
  incidentId,
  type Notice,
  subscriberId,
  webhookEndpointId,
  workspaceId,
} from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { webhookEndpoint, workspace } from "../schema/index.ts";
import {
  claimResend,
  createEndpoint,
  deleteEndpoint,
  findEndpointDelivery,
  findEndpointForSend,
  listDeliverableEndpoints,
  listEndpointDeliveries,
  listEndpoints,
  setEndpointHealth,
  settleResend,
} from "./endpoints.ts";
import {
  claimDelivery,
  countConfirmationsSince,
  countSubscribersFromIp,
  findDelivery,
  findSubscriber,
  findSubscriberByEmail,
  listActiveSubscribers,
  noteDeliveryError,
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
  expect(await countConfirmationsSince(db, acme, at("2026-09-30T11:00:00Z"))).toBe(1);
  expect(await countConfirmationsSince(db, acme, at("2026-09-30T13:00:00Z"))).toBe(0);
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

test("endpoints list without their secrets and move only from the state they were read in", async () => {
  const slack = webhookEndpointId.parse(v7());
  const hook = webhookEndpointId.parse(v7());
  await createEndpoint(db, {
    id: slack,
    workspaceId: acme,
    kind: "slack",
    name: "#status",
    componentIds: [],
    urlSealed: "v1.a.b",
    secretSealed: null,
  });
  await createEndpoint(db, {
    id: hook,
    workspaceId: acme,
    kind: "webhook",
    name: "Ops",
    componentIds: [api],
    urlSealed: "v1.c.d",
    secretSealed: "v1.e.f",
  });

  const listed = await listEndpoints(db, acme);
  expect(listed.map((e) => e.name)).toEqual(["#status", "Ops"]);
  expect(JSON.stringify(listed)).not.toContain("v1.");
  expect(await findEndpointForSend(db, hook)).toMatchObject({
    urlSealed: "v1.c.d",
    secretSealed: "v1.e.f",
  });

  const active = { state: "active" as const, failingSince: null };
  const failing = { state: "failing" as const, failingSince: new Date("2026-09-30T12:00:00Z") };
  expect(await setEndpointHealth(db, hook, active, failing)).toBe(true);
  // Read as active before the change above: it moved since, so this one is refused.
  const later = { state: "failing" as const, failingSince: new Date("2026-09-30T13:00:00Z") };
  expect(await setEndpointHealth(db, hook, active, later)).toBe(false);
  expect(listed.find((e) => e.id === hook)?.state).toBe("active");
  expect((await listEndpoints(db, acme)).find((e) => e.id === hook)).toMatchObject(failing);
  expect(await findEndpointForSend(db, hook)).toMatchObject(failing);
  // Failing again since a later time: a move read with the first time is refused too.
  const stale = { state: "failing" as const, failingSince: new Date("2026-09-29T12:00:00Z") };
  expect(await setEndpointHealth(db, hook, stale, active)).toBe(false);
  expect(await setEndpointHealth(db, hook, failing, active)).toBe(true);
  expect((await listEndpoints(db, acme)).find((e) => e.id === hook)).toMatchObject(active);

  await db.update(webhookEndpoint).set({ state: "disabled" }).where(eq(webhookEndpoint.id, slack));
  expect((await listDeliverableEndpoints(db, acme)).map((e) => e.id)).toEqual([hook]);
  expect(await deleteEndpoint(db, workspaceId.parse(v7()), hook)).toBe(false);
  expect(await deleteEndpoint(db, acme, hook)).toBe(true);
});

const notice = (title: string): Notice => ({
  kind: "incident_created",
  eventId: eventId.parse(v7()),
  page: { name: "Acme", url: "https://status.example.com" },
  title,
  status: "investigating",
  impact: "major",
  components: [],
  body: "Looking into it.",
  startsAt: "2026-09-30T12:00:00.000Z",
  endsAt: null,
  occurredAt: "2026-09-30T12:00:00.000Z",
  url: "https://status.example.com/incidents/x/",
});

test("an endpoint's deliveries keep their notice, list newest first, and can be sent again once settled", async () => {
  const hook = webhookEndpointId.parse(v7());
  await createEndpoint(db, {
    id: hook,
    workspaceId: acme,
    kind: "webhook",
    name: "Log",
    componentIds: [],
    urlSealed: "v1.g.h",
    secretSealed: "v1.i.j",
  });
  const record = async (n: Notice) => {
    const event = { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) };
    await recordDeliveries(db, event, [{ endpointId: hook, channel: "webhook", notice: n }]);
    const row = await findDelivery(db, n.eventId, { endpointId: hook });
    if (!row) throw new Error("no delivery");
    return row.id;
  };
  const older = await record(notice("Errors on API"));
  const newer = await record(notice("Slow checkout"));

  // Attempt 1 claims it once; the queue handing attempt 1 over again may retake it.
  expect(await claimDelivery(db, older, 1)).toBe(true);
  expect(await claimDelivery(db, older, 1)).toBe(false);
  expect(await claimDelivery(db, older, 1, true)).toBe(true);
  await noteDeliveryError(db, older, "The endpoint answered HTTP 503.");

  const log = await listEndpointDeliveries(db, acme, hook);
  expect(log.map((d) => d.title)).toEqual(["Slow checkout", "Errors on API"]);
  expect(log[1]).toMatchObject({
    kind: "incident_created",
    status: "pending",
    attempts: 1,
    lastError: "The endpoint answered HTTP 503.",
  });
  expect(await listEndpointDeliveries(db, workspaceId.parse(v7()), hook)).toEqual([]);

  await settleDelivery(db, older, { status: "failed", attempts: 1, lastError: "HTTP 503" });
  expect(await findEndpointDelivery(db, acme, hook, older)).toMatchObject({
    status: "failed",
    attempts: 1,
    notice: { title: "Errors on API" },
  });
  // A resend is one more attempt, claimed before it posts: two presses read at 1 claim it once.
  expect(await claimResend(db, older, 1)).toBe(2);
  expect(await claimResend(db, older, 1)).toBe(undefined);
  expect(await findEndpointDelivery(db, acme, hook, older)).toMatchObject({ status: "pending" });
  await settleResend(db, older, 2, { status: "sent", sentAt: new Date() });
  expect((await listEndpointDeliveries(db, acme, hook))[1]).toMatchObject({
    status: "sent",
    attempts: 2,
    lastError: null,
  });
  // A newer claim (attempt 3) keeps the row: an older resend settling late misses it.
  expect(await claimResend(db, older, 2)).toBe(3);
  await settleResend(db, older, 2, { status: "failed", lastError: "HTTP 500" });
  expect((await listEndpointDeliveries(db, acme, hook))[1]).toMatchObject({
    status: "pending",
    attempts: 3,
  });
  expect(await findEndpointDelivery(db, acme, webhookEndpointId.parse(v7()), newer)).toBe(
    undefined,
  );
});
