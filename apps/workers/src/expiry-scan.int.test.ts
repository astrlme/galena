import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  expiryPartition,
  type MonitorId,
  memberId,
  monitorId,
  monitorsFile,
  workspaceId,
} from "@galena/contracts";
import { createDb, type Db, listMemberIds, schema } from "@galena/db";
import type { DomainLookup } from "@galena/integrations/rdap";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type OutgoingEmail, sendEmail } from "./email.ts";
import { dynamoExpiryStore, type ExpiryScanDeps, scanExpiries } from "./expiry-scan.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const START = Date.parse("2026-11-08T09:25:00.000Z");
const acme = workspaceId.parse(v7());
// Another workspace, as a later multi-tenant deployment would hold, with a member of its own.
const globex = workspaceId.parse(v7());
const hank = memberId.parse(v7());
const api = monitorId.parse(v7());
const owner = memberId.parse(v7());
const viewer = memberId.parse(v7());

let dynamo: StartedTestContainer | undefined;
let postgres: StartedPostgreSqlContainer | undefined;
let doc: DynamoDBDocumentClient;
let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  [dynamo, postgres] = await Promise.all([
    new GenericContainer("amazon/dynamodb-local:3.3.1")
      .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory"])
      .withExposedPorts(8000)
      .start(),
    new PostgreSqlContainer("postgres:16-alpine").start(),
  ]);
  const client = new DynamoDBClient({
    endpoint: `http://${dynamo.getHost()}:${dynamo.getMappedPort(8000)}`,
    region: "eu-central-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  doc = DynamoDBDocumentClient.from(client);
  await client.send(
    new CreateTableCommand({
      TableName: "telemetry",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  const pg = createDb({ kind: "postgres", url: postgres.getConnectionUri() });
  ({ db, close } = pg);
  await pg.migrate();
  await db.insert(schema.workspace).values([
    { id: acme, name: "Acme" },
    { id: globex, name: "Globex" },
  ]);
  await db.insert(schema.user).values([
    { id: "u-ada", name: "Ada", email: "ada@acme.test" },
    { id: "u-bo", name: "Bo", email: "bo@acme.test" },
    { id: "u-hank", name: "Hank", email: "hank@globex.test" },
  ]);
  await db.insert(schema.member).values([
    { id: owner, workspaceId: acme, userId: "u-ada", role: "owner" },
    { id: viewer, workspaceId: acme, userId: "u-bo", role: "viewer" },
    { id: hank, workspaceId: globex, userId: "u-hank", role: "owner" },
  ]);
});

afterAll(async () => {
  await close?.();
  await Promise.all([dynamo?.stop(), postgres?.stop()]);
});

const monitorsOf = (ids: MonitorId[], url: string, workspace = acme) =>
  monitorsFile.parse({
    version: 1,
    generatedAt: new Date(START).toISOString(),
    monitors: ids.map((id) => ({
      id,
      workspaceId: workspace,
      type: "http",
      http: { url },
      downStatus: "major_outage",
      detection: {},
    })),
  }).monitors;

/** A result as the evaluator stores it: the probe's fields under `R#<minute>#<region>`. */
async function result(
  id: MonitorId,
  at: number,
  validTo: string | null,
  region = "eu-west-1",
  issuer = "Galena test CA",
) {
  await doc.send(
    new PutCommand({
      TableName: "telemetry",
      Item: {
        pk: `MON#${id}`,
        sk: `R#${new Date(at).toISOString()}#${region}`,
        status: validTo ? "up" : "down",
        ...(validTo && {
          certificate: { host: "api.acme.test", validTo, issuer },
        }),
      },
    }),
  );
}

async function expiryItems(workspace = acme) {
  const { Items = [] } = await doc.send(
    new QueryCommand({
      TableName: "telemetry",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": expiryPartition(workspace) },
    }),
  );
  return Items;
}

/**
 * The scan wired as in AWS except for the queue: `notify.email` runs at once, into this inbox,
 * for each key not started in the last 5 minutes, the span SQS FIFO deduplicates a key over.
 */
function harness(
  monitors: MonitorId[],
  lookups: Record<string, DomainLookup>,
  url = "https://api.acme.test/health",
) {
  const inbox: OutgoingEmail[] = [];
  const startedAt = new Map<string, number>();
  const store = dynamoExpiryStore(doc, "telemetry");
  const scan = (now: Date, overrides: Partial<ExpiryScanDeps> = {}) =>
    scanExpiries({
      now,
      store,
      monitors: async () => monitorsOf(monitors, url),
      lookUpDomains: async (domains) =>
        new Map(domains.map((d) => [d, lookups[d] ?? { status: "failed" }])),
      members: (workspace) => listMemberIds(db, workspace),
      warn: async (emails) => {
        for (const { payload, key } of emails) {
          const last = startedAt.get(key);
          if (last !== undefined && now.getTime() - last < 5 * 60_000) continue;
          startedAt.set(key, now.getTime());
          await sendEmail(payload, {
            db,
            keys: appKeys(LOCAL_APP_KEY),
            url: "https://status.acme.test",
            dashboardUrl: "https://dashboard.acme.test",
            mailer: {
              send: async (email) => {
                inbox.push(email);
                return { id: `ses-${inbox.length}` };
              },
            },
            now: () => now,
            attempt: 1,
          });
        }
      },
      ...overrides,
    });
  return { inbox, scan };
}

test("a certificate 10 days from expiry sends each member exactly one email per threshold", async () => {
  const validTo = new Date(START + 10 * DAY_MS).toISOString();
  await result(api, START - 60_000, validTo);
  const { inbox, scan } = harness([api], {
    "acme.test": { status: "found", expiresAt: "2027-06-01T00:00:00.000Z" },
  });

  // The first hour runs twice at once, as a retried schedule might.
  await Promise.all([scan(new Date(START)), scan(new Date(START))]);
  const items = await expiryItems();
  expect(items.find((item) => item.sk === "certificate#api.acme.test")).toMatchObject({
    expiresAt: validTo,
    issuer: "Galena test CA",
    monitorIds: [api],
  });
  expect(items.find((item) => item.sk === "domain#acme.test")).toMatchObject({
    expiresAt: "2027-06-01T00:00:00.000Z",
  });

  // Then hourly to the expiry. The run that crosses 7 days dies after starting its emails and
  // is retried within the queue's 5-minute deduplication, as a thrown error is.
  let failedOnce = false;
  for (let at = START + HOUR_MS; at <= START + 10 * DAY_MS; at += HOUR_MS) {
    const now = new Date(at);
    const crossing = at === START + 3 * DAY_MS;
    const store = dynamoExpiryStore(doc, "telemetry");
    if (crossing && !failedOnce) {
      failedOnce = true;
      const dies = { ...store, save: () => Promise.reject(new Error("Lambda timed out")) };
      await expect(scan(now, { store: dies })).rejects.toThrow("Lambda timed out");
    }
    await scan(now);
  }

  const subjects = (to: string) => inbox.filter((e) => e.to === to).map((e) => e.subject);
  for (const to of ["ada@acme.test", "bo@acme.test"]) {
    expect(subjects(to)).toEqual([
      "Certificate for api.acme.test expires in 10 days",
      "Certificate for api.acme.test expires in 7 days",
    ]);
  }
  expect(inbox).toHaveLength(4);
});

test("keeps a certificate through a week of its monitor being down, then lets it go", async () => {
  const web = monitorId.parse(v7());
  const at = START + 20 * DAY_MS;
  await result(web, at - 10 * 60_000, new Date(at + 60 * DAY_MS).toISOString());
  const { scan } = harness([web], {});
  await scan(new Date(at));
  // Down since: two whole minutes of every region with no handshake, all the scan reads.
  for (const minute of [at - 2 * 60_000, at - 60_000]) {
    for (const region of ["eu-west-1", "eu-west-3", "eu-north-1"]) {
      await result(web, minute, null, region);
    }
  }
  const certificate = async () =>
    (await expiryItems()).find((i) => i.sk === "certificate#api.acme.test");
  await scan(new Date(at + HOUR_MS));
  expect((await certificate())?.monitorIds).toEqual([web]);
  await scan(new Date(at + 7 * DAY_MS));
  expect(await certificate()).toBeDefined();
  await scan(new Date(at + 7 * DAY_MS + HOUR_MS));
  expect(await certificate()).toBeUndefined();
});

test("forgets a certificate once its monitor uses plain HTTP, or once no monitor reaches it", async () => {
  const site = monitorId.parse(v7());
  const at = START + 40 * DAY_MS;
  await result(site, at - 60_000, new Date(at + 60 * DAY_MS).toISOString());
  const certificates = async () =>
    (await expiryItems()).filter((i) => i.kind === "certificate").map((i) => i.sk);
  await harness([site], {}).scan(new Date(at));
  expect(await certificates()).toEqual(["certificate#api.acme.test"]);
  // Down and switched to http://: the old certificate isn't the one it reaches any more.
  for (const region of ["eu-west-1", "eu-west-3", "eu-north-1"]) {
    await result(site, at, null, region);
    await result(site, at + 60_000, null, region);
  }
  await harness([site], {}, "http://api.acme.test/health").scan(new Date(at + HOUR_MS));
  expect(await certificates()).toEqual([]);

  await result(site, at + 2 * 60_000, new Date(at + 60 * DAY_MS).toISOString());
  await harness([site], {}).scan(new Date(at + 2 * HOUR_MS));
  expect(await certificates()).toEqual(["certificate#api.acme.test"]);
  // Deleted: the workspace's other monitor never reached that certificate.
  await harness([monitorId.parse(v7())], {}).scan(new Date(at + 3 * HOUR_MS));
  expect(await certificates()).toEqual([]);
});

test("stores the certificate expiring first when regions see different ones", async () => {
  const edge = monitorId.parse(v7());
  const at = START + 60 * DAY_MS;
  const later = new Date(at + 80 * DAY_MS).toISOString();
  const sooner = new Date(at + 20 * DAY_MS).toISOString();
  // The newest-first query reads eu-west-3, then eu-west-1, then eu-north-1.
  await result(edge, at - 60_000, later, "eu-west-1", "Edge A");
  await result(edge, at - 60_000, later, "eu-west-3", "Edge A");
  await result(edge, at - 60_000, sooner, "eu-north-1", "Edge B");
  await harness([edge], {}).scan(new Date(at));
  expect((await expiryItems()).find((i) => i.sk === "certificate#api.acme.test")).toMatchObject({
    expiresAt: sooner,
    issuer: "Edge B",
  });
});

test("a host two workspaces watch is each workspace's own, and warns only its own members", async () => {
  const ours = monitorId.parse(v7());
  const theirs = monitorId.parse(v7());
  const at = START + 80 * DAY_MS;
  const validTo = new Date(at + 10 * DAY_MS).toISOString();
  await result(ours, at - 60_000, validTo);
  await result(theirs, at - 60_000, validTo);
  const url = "https://api.acme.test/health";
  const { inbox, scan } = harness([], {});
  await scan(new Date(at), {
    monitors: async () => [...monitorsOf([ours], url), ...monitorsOf([theirs], url, globex)],
  });

  const certificate = async (workspace: typeof acme) =>
    (await expiryItems(workspace)).find((i) => i.sk === "certificate#api.acme.test");
  expect((await certificate(acme))?.monitorIds).toEqual([ours]);
  expect((await certificate(globex))?.monitorIds).toEqual([theirs]);
  expect(inbox.map((e) => e.to).toSorted()).toEqual([
    "ada@acme.test",
    "bo@acme.test",
    "hank@globex.test",
  ]);
});
