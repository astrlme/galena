import { CreateScheduleCommand, type SchedulerClient } from "@aws-sdk/client-scheduler";
import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Clock, JobEngine } from "@galena/core";
import { type JobQueues, type JobRequest, toRequest } from "./sqs.ts";

export type SqsEngineDeps = {
  sqs: Pick<SQSClient, "send">;
  scheduler: Pick<SchedulerClient, "send">;
  clock: Clock;
  queues: JobQueues;
  /**
   * The deployment's schedule group, the role Scheduler sends to the queues as, and the standard
   * queue that keeps a job Scheduler could not deliver.
   */
  schedules: { group: string; roleArn: string; deadLetterArn: string };
};

// SQS takes at most ten messages per batch call.
const BATCH = 10;

/**
 * Jobs on SQS FIFO queues, and jobs for later as one-time EventBridge Scheduler schedules that
 * send to the same queues. FIFO deduplication lasts five minutes, so the jobs themselves guard
 * against a key repeated later (see each job's own checks).
 */
export function sqsEngine(deps: SqsEngineDeps): JobEngine {
  const { sqs, scheduler, clock, queues, schedules } = deps;

  async function schedule(request: Extract<JobRequest, { kind: "schedule" }>) {
    try {
      await scheduler.send(
        new CreateScheduleCommand({
          GroupName: schedules.group,
          Name: request.name,
          ScheduleExpression: `at(${request.at})`,
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: "OFF" },
          ActionAfterCompletion: "DELETE",
          Target: {
            Arn: request.queueArn,
            RoleArn: schedules.roleArn,
            Input: request.body,
            SqsParameters: { MessageGroupId: request.groupId },
            // Scheduler retries a failed send for 24 hours, then drops it unseen; an hour, then
            // the dead-letter queue and its alarm.
            DeadLetterConfig: { Arn: schedules.deadLetterArn },
            RetryPolicy: { MaximumEventAgeInSeconds: 3600 },
          },
        }),
      );
    } catch (error) {
      // A schedule by this name exists: the job was already scheduled.
      if (!(error instanceof Error && error.name === "ConflictException")) throw error;
    }
  }

  return {
    async trigger(task, payload, options) {
      const request = toRequest(task, payload, options, clock.now(), queues);
      if (request.kind === "schedule") return schedule(request);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: request.queueUrl,
          MessageGroupId: request.groupId,
          MessageDeduplicationId: request.dedupId,
          MessageBody: request.body,
        }),
      );
    },

    async triggerAll(task, jobs) {
      const now = clock.now();
      const requests = jobs.map((job) => toRequest(task, job.payload, job.options, now, queues));
      const sends = requests.filter((r) => r.kind === "send");
      for (let i = 0; i < sends.length; i += BATCH) {
        const chunk = sends.slice(i, i + BATCH);
        const { Failed = [] } = await sqs.send(
          new SendMessageBatchCommand({
            // One task, so one queue.
            QueueUrl: chunk[0]?.queueUrl,
            Entries: chunk.map((r, n) => ({
              Id: String(n),
              MessageGroupId: r.groupId,
              MessageDeduplicationId: r.dedupId,
              MessageBody: r.body,
            })),
          }),
        );
        if (Failed.length > 0) {
          const codes = [...new Set(Failed.map((f) => f.Code))].join(", ");
          throw new Error(
            `SQS refused ${Failed.length} of ${chunk.length} ${task} jobs: ${codes}.`,
          );
        }
      }
      for (const request of requests) {
        if (request.kind === "schedule") await schedule(request);
      }
    },
  };
}
