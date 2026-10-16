import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { monitorsFileFromS3 } from "@galena/integrations/config";
import { awsJobEngine } from "@galena/integrations/jobs";
import { env } from "./env.ts";
import { processBatch, type SqsRecord } from "./evaluator.ts";
import { createStore } from "./store.ts";

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

/** SQS FIFO event source with `ReportBatchItemFailures`. */
export async function handler(event: { Records: SqsRecord[] }) {
  const outcome = await processBatch(event.Records, {
    store,
    loadConfig,
    engine,
    regions: env.GLN_PROBE_REGIONS,
    now: () => new Date(),
    onError: (record, error) =>
      logger.error("message failed", { messageId: record.messageId, error }),
  });
  for (const t of outcome.transitions) {
    logger.info("monitor transitioned", {
      eventId: t.id,
      monitorId: t.data.monitorId,
      from: t.data.from,
      to: t.data.to,
      transitionSeq: t.data.transitionSeq,
    });
  }
  metrics.addMetric("transitions", MetricUnit.Count, outcome.transitions.length);
  // Fewer eligible regions than the quorum: the monitor held its state.
  metrics.addMetric("probe_degraded", MetricUnit.Count, outcome.insufficientRegions);
  metrics.publishStoredMetrics();
  return { batchItemFailures: outcome.batchItemFailures };
}
