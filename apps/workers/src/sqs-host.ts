import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { z } from "zod";
import { errorFields, log } from "./log.ts";
import { type Job, type Retry, runAttempt } from "./runner.ts";

/** The parts of an SQS event record the host reads. */
export type SqsJobRecord = {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: {
    ApproximateReceiveCount: string;
    MessageGroupId?: string;
    MessageDeduplicationId?: string;
  };
};

const message = z.object({ job: z.string(), key: z.string(), payload: z.unknown() });

// On trigger.dev these jobs fail on the first throw and a backstop or the sweep picks them up;
// here a transient fault gets two more tries first.
const DEFAULT_RETRY: Retry = { attempts: 3, minMs: 1_000, maxMs: 30_000, factor: 4 };

export type SqsHostDeps = {
  sqs: Pick<SQSClient, "send">;
  jobs: ReadonlyMap<string, Job<unknown>>;
  /** The queue this function reads, and its dead-letter queue. */
  queueUrl: string;
  deadLetterUrl: string;
};

/**
 * Runs jobs from an SQS FIFO event source with `ReportBatchItemFailures`. SQS counts the
 * attempts (`ApproximateReceiveCount`); a retry hides the message for the job's backoff, which
 * holds its lane as a queue holds a message it will deliver again. A job that failed for good is
 * never handed back, or SQS would run it again: its failure hook records it, or it goes to the
 * dead-letter queue, where an alarm sees it. The queue's own redrive catches crashes and timeouts.
 */
export function sqsHost({ sqs, jobs, queueUrl, deadLetterUrl }: SqsHostDeps) {
  const deadLetter = (record: SqsJobRecord) =>
    sqs.send(
      new SendMessageCommand({
        QueueUrl: deadLetterUrl,
        MessageBody: record.body,
        MessageGroupId: record.attributes.MessageGroupId,
        MessageDeduplicationId: record.attributes.MessageDeduplicationId ?? record.messageId,
      }),
    );

  /** Whether SQS should deliver the message again. */
  async function handle(record: SqsJobRecord): Promise<boolean> {
    const parsed = message.safeParse(safeJson(record.body));
    const job = parsed.success ? jobs.get(parsed.data.job) : undefined;
    if (!parsed.success || !job) {
      log.error("job message not understood", { messageId: record.messageId });
      await deadLetter(record);
      return false;
    }
    const { key, payload } = parsed.data;
    const attempt = Number(record.attributes.ApproximateReceiveCount);
    const result = await runAttempt(
      { ...job, retry: job.retry ?? DEFAULT_RETRY },
      payload,
      attempt,
    );
    if (result.outcome === "done") return false;
    if (result.outcome === "retry") {
      log.info(`${job.name} will retry`, { key, attempt, ...errorFields(result.error) });
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: Math.ceil(result.afterMs / 1000),
        }),
      );
      return true;
    }
    log.error(`${job.name} failed`, { key, attempt, ...errorFields(result.error) });
    if (!job.onFailure) await deadLetter(record);
    return false;
  }

  return async (event: { Records: SqsJobRecord[] }) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      const again = await handle(record).catch((error: unknown) => {
        log.error("job message not settled", {
          messageId: record.messageId,
          ...errorFields(error),
        });
        return true;
      });
      if (again) batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    return { batchItemFailures };
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
