import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { assertNever } from "@galena/core";
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

// A job without retry settings of its own gets five attempts, waiting 1 s, 4 s, 16 s and 30 s
// between them; a backstop or the sweep picks up what still fails.
const DEFAULT_RETRY: Retry = { attempts: 5, minMs: 1_000, maxMs: 30_000, factor: 4 };

// Time kept back from the function's timeout to hand the message back (or set it aside) after a
// job that ran out of time.
const SETTLE_MS = 10_000;

/**
 * Rejects once `ms` pass without `work` settling.
 * Known limit: `work` itself can't be stopped, so it may go on when this Lambda instance is next
 * invoked, beside the retry; the jobs' idempotency keys cover that as they cover a redelivery.
 * Pass jobs an `AbortSignal` if one ever can't bear it.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The job was still running after ${ms} ms.`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
 * never handed back, or SQS would run it again: its failure hook records it, or else it goes to
 * the dead-letter queue, where an alarm sees it. A job still running shortly before the function
 * times out counts as a failed attempt, so it backs off like any other instead of holding its
 * lane for the queue's whole visibility timeout; the queue's redrive catches crashes.
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
  async function handle(record: SqsJobRecord, remainingMs: () => number): Promise<boolean> {
    const parsed = message.safeParse(safeJson(record.body));
    const job = parsed.success ? jobs.get(parsed.data.job) : undefined;
    if (!parsed.success || !job) {
      log.error("job message not understood", { messageId: record.messageId });
      await deadLetter(record);
      return false;
    }
    const { key, payload } = parsed.data;
    const attempt = Number(record.attributes.ApproximateReceiveCount);
    const budget = Math.max(0, remainingMs() - SETTLE_MS);
    const result = await runAttempt(
      {
        ...job,
        retry: job.retry ?? DEFAULT_RETRY,
        run: (input, ctx) =>
          Number.isFinite(budget) ? withDeadline(job.run(input, ctx), budget) : job.run(input, ctx),
      },
      payload,
      attempt,
    );
    switch (result.outcome) {
      case "done":
        return false;
      case "retry":
        log.info(`${job.name} will retry`, { key, attempt, ...errorFields(result.error) });
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: Math.ceil(result.afterMs / 1000),
          }),
        );
        return true;
      case "failed":
        log.error(`${job.name} failed`, { key, attempt, ...errorFields(result.error) });
        // No hook kept it (none, a payload that doesn't parse, or the hook failed too).
        if (!result.recorded) await deadLetter(record);
        return false;
      default:
        return assertNever(result);
    }
  }

  /** `remainingMs`: the time left in the Lambda invocation (its context's), unbounded if absent. */
  return async (event: { Records: SqsJobRecord[] }, remainingMs = () => Infinity) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      const again = await handle(record, remainingMs).catch((error: unknown) => {
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
