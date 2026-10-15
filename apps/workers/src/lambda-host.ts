import { SQSClient } from "@aws-sdk/client-sqs";
import { queueEnv } from "./env.ts";
import type { Job } from "./runner.ts";
import { type SqsJobRecord, sqsHost } from "./sqs-host.ts";

/**
 * A Lambda handler on one SQS FIFO event source (batch size 1, `ReportBatchItemFailures`).
 * `load` runs once per container, before the first message, and returns the jobs this function
 * runs; a failed load is not kept, so the next message tries again.
 */
export function sqsLambda(load: (sqs: SQSClient) => Promise<ReadonlyMap<string, Job<unknown>>>) {
  const { GLN_QUEUE_URL: queueUrl, GLN_DEAD_LETTER_URL: deadLetterUrl } = queueEnv();
  const sqs = new SQSClient({});
  const start = async () => sqsHost({ sqs, jobs: await load(sqs), queueUrl, deadLetterUrl });
  let started: ReturnType<typeof start> | undefined;
  return async (event: { Records: SqsJobRecord[] }) => {
    started ??= start().catch((error: unknown) => {
      started = undefined;
      throw error;
    });
    return (await started)(event);
  };
}
