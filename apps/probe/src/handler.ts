import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { eventId, type ProbeMessage, probeMessageIds } from "@galena/contracts";
import { checkHttp } from "@galena/integrations/net";
import { v7 } from "uuid";
import { z } from "zod";
import { createConfigLoader, fetchFromS3 } from "./config.ts";
import { env } from "./env.ts";
import { runProbe } from "./probe.ts";

const logger = new Logger({ serviceName: "probe" });
const metrics = new Metrics({
  namespace: "Galena",
  serviceName: "probe",
  defaultDimensions: { region: env.AWS_REGION },
});
const s3 = new S3Client({ region: env.GLN_HOME_REGION });
const sqs = new SQSClient({ region: env.GLN_HOME_REGION });
const loadConfig = createConfigLoader(fetchFromS3(s3, env.GLN_CONFIG_BUCKET, env.GLN_CONFIG_KEY));

/** The Scheduler's input template passes `<aws.scheduler.scheduled-time>` through. */
const schedulerEvent = z.object({ scheduledAt: z.iso.datetime() });

async function send(batch: ProbeMessage[]) {
  const { Failed = [] } = await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: env.GLN_QUEUE_URL,
      Entries: batch.map((message, i) => {
        const ids = probeMessageIds(message);
        return {
          Id: String(i),
          MessageBody: JSON.stringify(message),
          MessageGroupId: ids.groupId,
          MessageDeduplicationId: ids.deduplicationId,
        };
      }),
    }),
  );
  // No retry here: the invocation fails, the Scheduler runs it again, and FIFO deduplication
  // drops whatever already arrived.
  if (Failed.length > 0)
    throw new Error(`SQS refused ${Failed.length} of ${batch.length} messages.`);
}

export async function handler(event: unknown) {
  const started = performance.now();
  const { scheduledAt } = schedulerEvent.parse(event);
  const file = await loadConfig();
  const { canary, results } = await runProbe(file, scheduledAt, {
    region: env.AWS_REGION,
    canaryUrl: env.GLN_CANARY_URL,
    check: (check) => checkHttp(check),
    send,
    newEventId: () => eventId.parse(v7()),
    now: () => new Date(),
  });

  for (const r of results) {
    if (r.status === "up") continue;
    logger.warn("check failed", {
      eventId: r.eventId,
      monitorId: r.monitorId,
      status: r.status,
      code: r.error?.code,
    });
  }
  if (!canary.passed) logger.warn("canary failed", { eventId: canary.eventId });

  metrics.addMetric("checks", MetricUnit.Count, results.length);
  metrics.addMetric(
    "checks_down",
    MetricUnit.Count,
    results.filter((r) => r.status === "down").length,
  );
  metrics.addMetric(
    "checks_error",
    MetricUnit.Count,
    results.filter((r) => r.status === "error").length,
  );
  metrics.addMetric("canary_failed", MetricUnit.Count, canary.passed ? 0 : 1);
  metrics.addMetric(
    "run_duration",
    MetricUnit.Milliseconds,
    Math.round(performance.now() - started),
  );
  metrics.publishStoredMetrics();
}
