import { memberId, workspaceId } from "@galena/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, type Db } from "../client.ts";
import { member, user, workspace } from "../schema/index.ts";
import { slackRepository } from "./slack.ts";
import { findMemberByEmail } from "./workspace.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const other = workspaceId.parse(v7());

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
  await db.insert(user).values([
    { id: "u-ada", name: "Ada", email: "ada@example.com" },
    { id: "u-bob", name: "Bob", email: "bob@example.com" },
  ]);
  await db.insert(member).values([
    { id: memberId.parse(v7()), workspaceId: acme, userId: "u-ada", role: "editor" },
    { id: memberId.parse(v7()), workspaceId: other, userId: "u-bob", role: "owner" },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

const install = (teamId: string, channelId = "C0INC") => ({
  teamId,
  teamName: "Acme",
  botUserId: "U0BOT",
  botTokenSealed: "sealed-token",
  channelId,
  channelName: "#incidents",
  installedByUserId: "u-ada",
});

test("finds an install by Slack team and by workspace; installing again updates it", async () => {
  const slack = slackRepository(db);
  await slack.save(acme, install("T0ACME"));
  await slack.save(acme, install("T0ACME", "C0OPS"));
  expect(await slack.findByTeam("T0ACME")).toMatchObject({ workspaceId: acme, channelId: "C0OPS" });
  expect(await slack.findByWorkspace(acme)).toMatchObject({ teamId: "T0ACME" });
  expect(await slack.findByTeam("T0NOPE")).toBeUndefined();
});

test("a workspace connects one Slack workspace: connecting another replaces it", async () => {
  const slack = slackRepository(db);
  await slack.save(acme, install("T0OTHER"));
  expect(await slack.findByTeam("T0ACME")).toBeUndefined();
  expect(await slack.findByWorkspace(acme)).toMatchObject({ teamId: "T0OTHER" });
});

test("removing returns the sealed token, so the caller can revoke it", async () => {
  const slack = slackRepository(db);
  expect(await slack.remove(acme)).toMatchObject({ botTokenSealed: "sealed-token" });
  expect(await slack.findByWorkspace(acme)).toBeUndefined();
  expect(await slack.remove(acme)).toBeUndefined();
});

test("forgets a revoked install only while it still holds that token", async () => {
  const slack = slackRepository(db);
  await slack.save(acme, { ...install("T0ACME"), botTokenSealed: "sealed-new" });
  expect(await slack.removeRevoked(acme, "sealed-old")).toBe(false);
  expect(await slack.findByWorkspace(acme)).toBeDefined();
  expect(await slack.removeRevoked(acme, "sealed-new")).toBe(true);
  expect(await slack.findByWorkspace(acme)).toBeUndefined();
});

test("finds a member by email, in that workspace only, whatever the case", async () => {
  expect(await findMemberByEmail(db, acme, "ADA@example.com")).toEqual({
    userId: "u-ada",
    role: "editor",
  });
  expect(await findMemberByEmail(db, acme, "bob@example.com")).toBeUndefined();
  expect(await findMemberByEmail(db, acme, "nobody@example.com")).toBeUndefined();
});
