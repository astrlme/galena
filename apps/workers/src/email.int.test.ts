import { setTimeout as sleep } from "node:timers/promises";
import {
  componentId,
  eventId,
  incidentId,
  type Notice,
  type SubscriberId,
  subscriberId,
  workspaceId,
} from "@galena/contracts";
import {
  createDb,
  type Db,
  findDelivery,
  recordDeliveries,
  saveSubscriber,
  schema,
} from "@galena/db";
import { appKeys, LOCAL_APP_KEY, readLinkToken } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type EmailDeps, failEmail, type OutgoingEmail, sendEmail } from "./email.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const keys = appKeys(LOCAL_APP_KEY);
const url = "https://status.example.com";
const now = new Date("2026-09-30T12:00:00.000Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values({ id: acme, name: "Acme" });
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

function inbox() {
  const sent: OutgoingEmail[] = [];
  const deps: EmailDeps = {
    db,
    keys,
    url,
    now: () => now,
    mailer: {
      send: async (email) => {
        sent.push(email);
        return { id: `ses-${sent.length}` };
      },
    },
  };
  return { sent, deps };
}

const subscriber = async (
  email: string,
  state: "pending_confirmation" | "active" | "unsubscribed",
) => {
  const id = subscriberId.parse(v7());
  await saveSubscriber(db, {
    id,
    workspaceId: acme,
    email,
    state,
    componentIds: [],
    confirmSentAt: now,
    ipHash: null,
  });
  return id;
};

const notice = (): Notice => ({
  kind: "incident_created",
  eventId: eventId.parse(v7()),
  page: { name: "Acme", url },
  title: "Errors on API",
  status: "investigating",
  impact: "major",
  components: [{ id: componentId.parse(v7()), name: "API", status: "partial_outage" }],
  body: "We're looking into it.",
  startsAt: now.toISOString(),
  endsAt: null,
  occurredAt: now.toISOString(),
  url: `${url}/incidents/x/`,
});

/** The dispatcher records a confirmation's delivery before it starts the send. */
async function confirmation(id: SubscriberId) {
  const event = eventId.parse(v7());
  await recordDeliveries(db, { workspaceId: acme, eventId: event, subjectId: id }, [
    { subscriberId: id, channel: "email" },
  ]);
  return { kind: "confirmation" as const, subscriberId: id, eventId: event };
}

test("a pending subscriber gets a confirmation link the API will accept, once", async () => {
  const { sent, deps } = inbox();
  const id = await subscriber("ada@example.com", "pending_confirmation");
  const request = await confirmation(id);
  expect(await sendEmail(request, deps)).toBe("sent");
  expect(await sendEmail(request, deps)).toBe("already_settled");
  expect(sent).toHaveLength(1);
  expect(await findDelivery(db, request.eventId, { subscriberId: id })).toMatchObject({
    status: "sent",
    attempts: 1,
  });
  expect(sent[0]).toMatchObject({ to: "ada@example.com", fromName: "Acme" });
  const link = /https:\/\/status\.example\.com\/subscription\/confirm\/\?t=(\S+)/.exec(
    sent[0]?.text ?? "",
  );
  expect(readLinkToken(keys, "confirm", decodeURIComponent(link?.[1] ?? ""))).toEqual({
    id,
    issuedAt: now,
  });
  // Confirmed in the meantime: nothing more to send.
  const active = await subscriber("grace@example.com", "active");
  expect(await sendEmail(await confirmation(active), deps)).toBe("skipped");
});

test("a notice goes out once, with one-click unsubscribe, and is recorded as sent", async () => {
  const { sent, deps } = inbox();
  const id = await subscriber("linus@example.com", "active");
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [{ subscriberId: id, channel: "email" }],
  );
  const request = { kind: "notice" as const, subscriberId: id, notice: n };
  expect(await sendEmail(request, deps)).toBe("sent");
  expect(await sendEmail(request, deps)).toBe("already_settled");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.subject).toBe("▲︎ Partial outage: API");
  expect(sent[0]?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  const oneClick = /^<https:\/\/status\.example\.com\/public\/unsubscribe\?t=(\S+)>$/.exec(
    sent[0]?.headers["List-Unsubscribe"] ?? "",
  );
  expect(readLinkToken(keys, "unsubscribe", decodeURIComponent(oneClick?.[1] ?? ""))?.id).toBe(id);
  expect(await findDelivery(db, n.eventId, { subscriberId: id })).toMatchObject({
    status: "sent",
    attempts: 1,
  });
});

test("two runs sending the same notice at once send it once", async () => {
  const { sent, deps } = inbox();
  const slow = {
    ...deps,
    // Both runs read the pending row before either one settles it.
    mailer: { send: (email: OutgoingEmail) => sleep(50).then(() => deps.mailer.send(email)) },
  };
  const id = await subscriber("katherine@example.com", "active");
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [{ subscriberId: id, channel: "email" }],
  );
  const request = { kind: "notice" as const, subscriberId: id, notice: n };
  const outcomes = await Promise.all([sendEmail(request, slow), sendEmail(request, slow)]);
  expect(outcomes.sort()).toEqual(["already_settled", "sent"]);
  expect(sent).toHaveLength(1);
  expect(await findDelivery(db, n.eventId, { subscriberId: id })).toMatchObject({
    status: "sent",
    attempts: 1,
  });
});

test("someone who unsubscribed before the send is skipped; a send that keeps failing is marked", async () => {
  const { sent, deps } = inbox();
  const gone = await subscriber("margaret@example.com", "unsubscribed");
  const failing = await subscriber("barbara@example.com", "active");
  const n = notice();
  await recordDeliveries(
    db,
    { workspaceId: acme, eventId: n.eventId, subjectId: incidentId.parse(v7()) },
    [
      { subscriberId: gone, channel: "email" },
      { subscriberId: failing, channel: "email" },
    ],
  );
  expect(await sendEmail({ kind: "notice", subscriberId: gone, notice: n }, deps)).toBe("skipped");
  expect(sent).toHaveLength(0);
  expect((await findDelivery(db, n.eventId, { subscriberId: gone }))?.status).toBe("skipped");

  await failEmail({ kind: "notice", subscriberId: failing, notice: n }, "Throttling: slow down", {
    db,
  });
  expect(await findDelivery(db, n.eventId, { subscriberId: failing })).toMatchObject({
    status: "failed",
  });
});
