import {
  componentId,
  type IncidentId,
  incidentId,
  incidentUpdateId,
  memberId,
  type OutboxId,
  workspaceId,
} from "@galena/contracts";
import { createDb, type Db, incidentRepository, schema, slackRepository } from "@galena/db";
import { appKeys, LOCAL_APP_KEY, seal } from "@galena/integrations/secrets";
import { type SlackMessage, slackRefusals } from "@galena/integrations/slack";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { v7 } from "uuid";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { DraftAnswer } from "./autopilot.ts";
import { answerClick, answerCommand, postApprovalCard, type SlackDeps } from "./slack.ts";

let container: StartedPostgreSqlContainer | undefined;
let db: Db;
let close: (() => Promise<void>) | undefined;
const acme = workspaceId.parse(v7());
const quiet = workspaceId.parse(v7());
const checkout = componentId.parse(v7());
const keys = appKeys(LOCAL_APP_KEY);
const NOW = new Date("2026-10-08T15:55:00.000Z");

// Slack, as far as these paths reach it.
const posted: { token: string; channel: string; message: SlackMessage }[] = [];
const responded: { url: string; message: SlackMessage & Record<string, unknown> }[] = [];
const emails: Record<string, string> = {
  U0ADA: "ada@example.com",
  U0VIC: "vic@example.com",
  U0STR: "stranger@example.com",
};
const completed: [string, DraftAnswer][] = [];
const dispatched: OutboxId[] = [];
let deps: SlackDeps;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const client = createDb({ kind: "postgres", url: container.getConnectionUri() });
  db = client.db;
  close = client.close;
  await client.migrate();
  await db.insert(schema.workspace).values([
    { id: acme, name: "Acme" },
    { id: quiet, name: "Quiet" },
  ]);
  await db
    .insert(schema.component)
    .values({ id: checkout, workspaceId: acme, name: "Checkout", position: 0 });
  await db.insert(schema.user).values([
    { id: "u-ada", name: "Ada", email: "ada@example.com" },
    { id: "u-vic", name: "Vic", email: "vic@example.com" },
  ]);
  await db.insert(schema.member).values([
    { id: memberId.parse(v7()), workspaceId: acme, userId: "u-ada", role: "editor" },
    { id: memberId.parse(v7()), workspaceId: acme, userId: "u-vic", role: "viewer" },
  ]);
  await slackRepository(db).save(acme, {
    teamId: "T0ACME",
    teamName: "Acme",
    botUserId: "U0BOT",
    botTokenSealed: seal(keys, "xoxb-test"),
    channelId: "C0INC",
    channelName: "#incidents",
    installedByUserId: "u-ada",
  });
  deps = {
    db,
    keys,
    clock: { now: () => NOW },
    dashboardUrl: "https://dashboard.example.com",
    dispatch: async (id) => void dispatched.push(id),
    completeToken: async (tokenId, answer) => void completed.push([tokenId, answer]),
    api: {
      postMessage: async (token, channel, message) => {
        posted.push({ token, channel, message });
        return { channel, ts: "1728402900.000100" };
      },
      userEmail: async (token, user) => {
        expect(token).toBe("xoxb-test");
        return emails[user];
      },
      respond: async (url, message) => void responded.push({ url, message }),
    },
  };
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

/** A draft a monitor opened on Checkout, waiting on approval token `token`. */
async function draft(token: string): Promise<IncidentId> {
  const id = incidentId.parse(v7());
  const startedAt = new Date("2026-10-08T15:53:00.000Z");
  await incidentRepository(db).createOnce(
    {
      id,
      workspaceId: acme,
      title: "Checkout is not responding",
      impact: "major",
      visibility: "draft",
      source: "monitor",
      startedAt,
      dedupKey: `mon:${id}`,
      approvalDeadline: new Date("2026-10-08T16:03:00.000Z"),
    },
    {
      update: {
        id: incidentUpdateId.parse(v7()),
        status: "investigating",
        body: "We're seeing timeouts on Checkout from 3 regions.",
        createdAt: startedAt,
        createdByUserId: null,
      },
      stage: { status: "investigating", resolvedAt: null },
      components: [{ componentId: checkout, status: "major_outage" }],
      statusChange: { from: null, to: "investigating" },
    },
  );
  await incidentRepository(db).setApprovalToken(acme, id, token);
  return id;
}
const click = (id: IncidentId, userId: string, decision: "publish" | "dismiss" = "publish") => ({
  teamId: "T0ACME",
  userId,
  decision,
  incidentId: id,
  responseUrl: "https://hooks.slack.com/actions/T0ACME/1/abc",
});
const visibilityOf = async (id: IncidentId) =>
  (await incidentRepository(db).findById(acme, id))?.visibility;

test("posts a draft's card to the channel picked on install, with the bot's token", async () => {
  const id = await draft("waitpoint_card");
  expect(await postApprovalCard({ workspaceId: acme, incidentId: id }, deps)).toBe("posted");
  expect(posted.at(-1)).toMatchObject({ token: "xoxb-test", channel: "C0INC" });
  expect(posted.at(-1)?.message.text).toContain("Publishes automatically at 16:03 UTC");
  expect(await postApprovalCard({ workspaceId: quiet, incidentId: id }, deps)).toBe("no_install");
});

test("an editor's press publishes the draft as them, wakes the run and replaces the card", async () => {
  const id = await draft("waitpoint_ada");
  expect(await answerClick(click(id, "U0ADA"), deps)).toBe("published");
  expect(await visibilityOf(id)).toBe("published");
  const audit = (await db.select().from(schema.auditLog)).find(
    (row) => row.targetId === id && row.action === "incident.updated",
  );
  expect(audit?.actorUserId).toBe("u-ada");
  expect(dispatched).toHaveLength(1);
  expect(completed).toEqual([["waitpoint_ada", { decision: "approve" }]]);
  const card = responded.at(-1);
  expect(card?.message.replace_original).toBe(true);
  expect(JSON.stringify(card?.message)).toContain("*Published* by <@U0ADA> at 15:55 UTC.");

  // Pressed again, from an older copy of the card: nothing changes, and it says why.
  expect(await answerClick(click(id, "U0ADA", "dismiss"), deps)).toBe("already_decided");
  expect(responded.at(-1)?.message).toMatchObject({
    text: slackRefusals.decided,
    response_type: "ephemeral",
    replace_original: false,
  });
  expect(await visibilityOf(id)).toBe("published");
});

test("a viewer or someone who isn't a member changes nothing, and is told why", async () => {
  const id = await draft("waitpoint_vic");
  expect(await answerClick(click(id, "U0VIC"), deps)).toBe("viewer");
  expect(responded.at(-1)?.message.text).toBe(slackRefusals.viewer);
  expect(await answerClick(click(id, "U0STR"), deps)).toBe("not_a_member");
  expect(responded.at(-1)?.message.text).toBe(slackRefusals.notMember);
  expect(await visibilityOf(id)).toBe("draft");
  expect(completed.map(([token]) => token)).not.toContain("waitpoint_vic");
});

test("a press from a Slack workspace that isn't connected is told to reconnect", async () => {
  const id = await draft("waitpoint_gone");
  expect(await answerClick({ ...click(id, "U0ADA"), teamId: "T0GONE" }, deps)).toBe(
    "not_installed",
  );
  expect(responded.at(-1)?.message.text).toBe(slackRefusals.notInstalled);
  expect(await visibilityOf(id)).toBe("draft");
});

test("/incident lists what's open, with buttons on drafts, for members only", async () => {
  const request = {
    teamId: "T0ACME",
    userId: "U0VIC",
    responseUrl: "https://hooks.slack.com/commands/T0ACME/2/def",
  };
  expect(await answerCommand(request, deps)).toBe("listed");
  const list = JSON.stringify(responded.at(-1)?.message);
  expect(list).toContain("Open incidents");
  expect(list).toContain('"action_id":"approve"');
  expect(responded.at(-1)?.message.response_type).toBe("ephemeral");
  expect(await answerCommand({ ...request, userId: "U0STR" }, deps)).toBe("not_a_member");
});
