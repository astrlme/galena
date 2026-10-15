import { slackClick, slackCommandRequest } from "@galena/contracts";
import { guard } from "@galena/integrations/net";
import { appKeys } from "@galena/integrations/secrets";
import { SlackApiError, slackApi } from "@galena/integrations/slack";
import { db } from "../db.ts";
import { triggerDispatch } from "../engine.ts";
import { appKey, env } from "../env.ts";
import { log } from "../log.ts";
import { defineJob, FinalError, type Retry } from "../runner.ts";
import {
  answerClick,
  answerCommand,
  cardPayload,
  postApprovalCard,
  type SlackDeps,
} from "../slack.ts";

// Slack rate limits and outages are worth another try; a revoked token or a missing channel won't
// change by trying again.
const retry: Retry = { attempts: 5, factor: 2, minMs: 2_000, maxMs: 60_000 };

const deps: SlackDeps = {
  db,
  keys: appKeys(appKey()),
  clock: { now: () => new Date() },
  api: slackApi({ guard }),
  dashboardUrl: env.GLN_DASHBOARD_URL,
  dispatch: triggerDispatch,
};

/** Runs `work`, failing at once when Slack's answer won't change on a retry. */
async function withSlack<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SlackApiError && !error.retryable) throw new FinalError(error.message);
    throw error;
  }
}

/** A draft's approval card, posted once, keyed `card:{incidentId}`. */
export const slackApprovalCardJob = defineJob({
  name: "slack.approval-card",
  payload: cardPayload,
  retry,
  run: async (request) => {
    const outcome = await withSlack(() => postApprovalCard(request, deps));
    log.info("slack.approval-card", { incidentId: request.incidentId, outcome });
    return { outcome };
  },
});

/** A press of Approve or Dismiss, keyed per press by the API. */
export const slackInteractionJob = defineJob({
  name: "slack.interaction",
  payload: slackClick,
  retry,
  run: async (click) => {
    const outcome = await withSlack(() => answerClick(click, deps));
    log.info("slack.interaction", {
      incidentId: click.incidentId,
      decision: click.decision,
      outcome,
    });
    return { outcome };
  },
});

/** `/incident`, keyed per command by the API. */
export const slackCommandJob = defineJob({
  name: "slack.command",
  payload: slackCommandRequest,
  retry,
  run: async (request) => {
    const outcome = await withSlack(() => answerCommand(request, deps));
    log.info("slack.command", { outcome });
    return { outcome };
  },
});
