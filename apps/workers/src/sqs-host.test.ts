import { ChangeMessageVisibilityCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { defineJob, FinalError, type Job } from "./runner.ts";
import { type SqsJobRecord, sqsHost } from "./sqs-host.ts";

const QUEUE = "https://sqs/jobs.fifo";
const DLQ = "https://sqs/jobs-dlq.fifo";

function setup(job: Job<{ n: number }>, { failSqs = false } = {}) {
  const sent: object[] = [];
  const handle = sqsHost({
    sqs: {
      send: async (command: object) => {
        if (failSqs) throw new Error("SQS is down.");
        sent.push(command);
        return {};
      },
    } as Parameters<typeof sqsHost>[0]["sqs"],
    jobs: new Map([[job.name, job as unknown as Job<unknown>]]),
    queueUrl: QUEUE,
    deadLetterUrl: DLQ,
  });
  return { handle, sent };
}

const record = (
  receive: number,
  body: unknown = { job: "test.job", key: "k:1", payload: { n: 1 } },
) =>
  ({
    messageId: "m1",
    receiptHandle: "r1",
    body: typeof body === "string" ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: String(receive),
      MessageGroupId: "lane",
      MessageDeduplicationId: "dedup",
    },
  }) satisfies SqsJobRecord;

const failing = (settings: Partial<Job<{ n: number }>> = {}) =>
  defineJob({
    name: "test.job",
    payload: z.object({ n: z.number() }),
    run: async () => {
      throw new Error("down");
    },
    ...settings,
  });

test("a job that finishes leaves its message to be deleted", async () => {
  const run = vi.fn(async () => "ok");
  const { handle, sent } = setup(
    defineJob({ name: "test.job", payload: z.object({ n: z.number() }), run }),
  );
  expect(await handle({ Records: [record(1)] })).toEqual({ batchItemFailures: [] });
  expect(run).toHaveBeenCalledWith({ n: 1 }, { attempt: 1 });
  expect(sent).toEqual([]);
});

test("a failed attempt with retries left waits out its backoff, counted by receives", async () => {
  const { handle, sent } = setup(
    failing({ retry: { attempts: 5, minMs: 2_000, maxMs: 60_000, factor: 2 } }),
  );
  expect(await handle({ Records: [record(3)] })).toEqual({
    batchItemFailures: [{ itemIdentifier: "m1" }],
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect((sent[0] as ChangeMessageVisibilityCommand).input).toEqual({
    QueueUrl: QUEUE,
    ReceiptHandle: "r1",
    VisibilityTimeout: 8,
  });
});

test("a job with no retry settings gets five attempts", async () => {
  const onFailure = vi.fn(async () => {});
  const { handle } = setup(failing({ onFailure }));
  expect((await handle({ Records: [record(4)] })).batchItemFailures).toHaveLength(1);
  expect((await handle({ Records: [record(5)] })).batchItemFailures).toHaveLength(0);
  expect(onFailure).toHaveBeenCalledOnce();
});

test("a final failure with a failure hook runs it and goes no further", async () => {
  const onFailure = vi.fn(async () => {});
  const { handle, sent } = setup(
    failing({
      onFailure,
      run: async () => {
        throw new FinalError("refused");
      },
    }),
  );
  expect(await handle({ Records: [record(1)] })).toEqual({ batchItemFailures: [] });
  expect(onFailure).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test("a final failure nothing records goes to the dead-letter queue, once", async () => {
  const { handle, sent } = setup(
    failing({
      run: async () => {
        throw new FinalError("refused");
      },
    }),
  );
  expect(await handle({ Records: [record(1)] })).toEqual({ batchItemFailures: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBeInstanceOf(SendMessageCommand);
  expect((sent[0] as SendMessageCommand).input).toEqual({
    QueueUrl: DLQ,
    MessageBody: record(1).body,
    MessageGroupId: "lane",
    MessageDeduplicationId: "dedup",
  });
});

test.each([
  ["an unknown job", { job: "nope", key: "k", payload: {} }],
  ["a body that isn't a job message", "not json"],
  [
    "a payload the job refuses, though it has a failure hook",
    { job: "test.job", key: "k", payload: { n: "1" } },
  ],
])("%s goes to the dead-letter queue", async (_, body) => {
  const { handle, sent } = setup(failing({ onFailure: async () => {} }));
  expect(await handle({ Records: [record(1, body)] })).toEqual({ batchItemFailures: [] });
  expect((sent[0] as SendMessageCommand).input.QueueUrl).toBe(DLQ);
});

test("a final failure whose hook fails too goes to the dead-letter queue, not back to SQS", async () => {
  const run = vi.fn(async () => {
    throw new FinalError("refused");
  });
  const { handle, sent } = setup(
    failing({
      run,
      onFailure: async () => {
        throw new Error("database resuming");
      },
    }),
  );
  expect(await handle({ Records: [record(1)] })).toEqual({ batchItemFailures: [] });
  expect((sent[0] as SendMessageCommand).input.QueueUrl).toBe(DLQ);
  expect(run).toHaveBeenCalledOnce();
});

test("when SQS can't take the retry or the dead letter, the message comes back", async () => {
  const { handle } = setup(
    failing({
      run: async () => {
        throw new FinalError("refused");
      },
    }),
    { failSqs: true },
  );
  expect(await handle({ Records: [record(1)] })).toEqual({
    batchItemFailures: [{ itemIdentifier: "m1" }],
  });
});
