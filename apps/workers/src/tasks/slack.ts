import { slackClick, slackCommandRequest } from "@galena/contracts";
import { guard } from "@galena/integrations/net";
import { appKeys, LOCAL_APP_KEY } from "@galena/integrations/secrets";
import { SlackApiError, slackApi } from "@galena/integrations/slack";
import { AbortTaskRunError, logger, queue, task, wait } from "@trigger.dev/sdk";
import { db } from "../db.ts";
import { env } from "../env.ts";
import {
  answerClick,
  answerCommand,
  cardPayload,
  postApprovalCard,
  type SlackDeps,
} from "../slack.ts";
import { dispatchOutbox } from "./incident-autopilot.ts";

const slackApp = queue({ name: "slack-app", concurrencyLimit: 5 });
// Slack rate limits and outages are worth another try; a revoked token or a missing channel won't
// change by trying again.
const retry = { maxAttempts: 5, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000 };

const deps: SlackDeps = {
  db,
  keys: appKeys(env.GLN_APP_KEY ?? LOCAL_APP_KEY),
  clock: { now: () => new Date() },
  api: slackApi({ guard }),
  dashboardUrl: env.GLN_DASHBOARD_URL,
  dispatch: dispatchOutbox,
  completeToken: async (tokenId, answer) => {
    await wait.completeToken(tokenId, answer);
  },
};

/** Runs `work`, ending the run at once when Slack's answer won't change on a retry. */
async function withSlack<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SlackApiError && !error.retryable) {
      throw new AbortTaskRunError(error.message);
    }
    throw error;
  }
}

export const slackApprovalCard = task({
  id: "slack.approval-card",
  queue: slackApp,
  retry,
  run: async (payload: unknown) => {
    const request = cardPayload.parse(payload);
    const outcome = await withSlack(() => postApprovalCard(request, deps));
    logger.info("slack.approval-card", { incidentId: request.incidentId, outcome });
    return { outcome };
  },
});

/** A press of Approve or Dismiss, keyed per press by the API. */
export const slackInteraction = task({
  id: "slack.interaction",
  queue: slackApp,
  retry,
  run: async (payload: unknown) => {
    const click = slackClick.parse(payload);
    const outcome = await withSlack(() => answerClick(click, deps));
    logger.info("slack.interaction", {
      incidentId: click.incidentId,
      decision: click.decision,
      outcome,
    });
    return { outcome };
  },
});

/** `/incident`, keyed per command by the API. */
export const slackCommand = task({
  id: "slack.command",
  queue: slackApp,
  retry,
  run: async (payload: unknown) => {
    const request = slackCommandRequest.parse(payload);
    const outcome = await withSlack(() => answerCommand(request, deps));
    logger.info("slack.command", { outcome });
    return { outcome };
  },
});
