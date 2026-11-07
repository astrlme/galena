import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { eventId, type MonitorTransitioned } from "@galena/contracts";
import { monitorsFileFromS3 } from "@galena/integrations/config";
import { awsJobEngine } from "@galena/integrations/jobs/aws";
import { heartbeat } from "@galena/integrations/net";
import { v7 } from "uuid";
import { z } from "zod";
import { env } from "./env.ts";
import { processBatch, type SqsRecord } from "./evaluator.ts";
import { createStore } from "./store.ts";
import { sweepHeartbeats } from "./sweep.ts";

const logger = new Logger({ serviceName: "evaluator" });
const metrics = new Metrics({
  namespace: "Galena",
  serviceName: "evaluator",
  defaultDimensions: { region: env.AWS_REGION },
});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const store = createStore(doc, env.GLN_TELEMETRY_TABLE);
const loadConfig = monitorsFileFromS3({
  region: env.AWS_REGION,
  bucket: env.GLN_CONFIG_BUCKET,
  key: env.GLN_CONFIG_KEY,
});
// The only job the hot path starts, one message on a transition, never per check.
const engine = awsJobEngine({
  queues: {
    jobs: { url: env.GLN_JOBS_QUEUE_URL, arn: env.GLN_JOBS_QUEUE_ARN },
    builds: { url: env.GLN_BUILDS_QUEUE_URL, arn: env.GLN_BUILDS_QUEUE_ARN },
  },
  schedules: {
    group: env.GLN_SCHEDULE_GROUP,
    roleArn: env.GLN_SCHEDULER_ROLE_ARN,
    deadLetterArn: env.GLN_SCHEDULE_DEAD_LETTER_ARN,
  },
});
// Read once at cold start. Without it there is no outside dead-man's switch, and an optional
// ping never stops detection: a read that fails leaves it off, which the switch then reports.
const heartbeatUrl = env.GLN_HEARTBEAT_PARAM
  ? await new SSMClient({})
      .send(new GetParameterCommand({ Name: env.GLN_HEARTBEAT_PARAM, WithDecryption: true }), {
        abortSignal: AbortSignal.timeout(5_000),
      })
      .then(({ Parameter }) => Parameter?.Value)
      .catch((error: unknown) => {
        if (!(error instanceof ParameterNotFound)) {
          logger.warn("heartbeat URL not read", {
            error: error instanceof Error ? error.name : typeof error,
          });
        }
        return undefined;
      })
  : undefined;
// Known limit: one ping a minute per evaluator container. Healthchecks asks for at most five a
// minute per check, so past about five busy containers (one per monitor at most) it may drop some;
// the rest still keep the check up. Ping from a single container if that ever matters.
const beat = heartbeat({
  url: heartbeatUrl,
  onFailure: (reason) => logger.warn("heartbeat ping failed", reason),
});

const onError = (record: SqsRecord, error: unknown) =>
  logger.error("message failed", { messageId: record.messageId, error });

function logTransitions(transitions: readonly MonitorTransitioned[]) {
  for (const t of transitions) {
    logger.info("monitor transitioned", {
      eventId: t.id,
      monitorId: t.data.monitorId,
      from: t.data.from,
      to: t.data.to,
      transitionSeq: t.data.transitionSeq,
    });
  }
}

/** SQS FIFO event source with `ReportBatchItemFailures`. */
export async function handler(event: { Records: SqsRecord[] }) {
  const outcome = await processBatch(event.Records, {
    store,
    loadConfig,
    engine,
    regions: env.GLN_PROBE_REGIONS,
    now: () => new Date(),
    onError,
  });
  logTransitions(outcome.transitions);
  metrics.addMetric("transitions", MetricUnit.Count, outcome.transitions.length);
  // Fewer eligible regions than the quorum: the monitor held its state.
  metrics.addMetric("probe_degraded", MetricUnit.Count, outcome.insufficientRegions);
  metrics.publishStoredMetrics();
  // Results arrived and at least one was evaluated: detection runs. A batch that failed whole
  // (DynamoDB down, say) sends no ping.
  if (outcome.batchItemFailures.length < event.Records.length) await beat();
  return { batchItemFailures: outcome.batchItemFailures };
}

/** The Scheduler's input template passes `<aws.scheduler.scheduled-time>` through. */
const schedulerEvent = z.object({ scheduledAt: z.iso.datetime() });

/**
 * The heartbeat sweeper, every minute from the Scheduler (its own function, same bundle). Nothing
 * retries a minute (the next one judges every heartbeat again); a failure throws only so the
 * errors alarm sees it.
 */
export async function sweep(event: unknown) {
  const { scheduledAt } = schedulerEvent.parse(event);
  const outcome = await sweepHeartbeats(await loadConfig(), scheduledAt, {
    store,
    engine,
    region: env.AWS_REGION,
    newEventId: () => eventId.parse(v7()),
    now: () => new Date(),
    onError,
  });
  logTransitions(outcome.transitions);
  if (outcome.failed > 0)
    throw new Error(`${outcome.failed} heartbeat monitors weren't evaluated.`);
}
