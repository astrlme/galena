import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { sqsEngine } from "@galena/integrations/jobs";
import { z } from "zod";
import { setEngine } from "./engine.ts";
import { type SqsJobRecord, sqsHost } from "./sqs-host.ts";

// Read here, not in env.ts: env.ts parses when the first job module loads, and the app key it
// requires comes from SSM first.
const host = z
  .object({
    GLN_APP_KEY_PARAM: z.string().startsWith("/"),
    /** The queue this function reads, and its dead-letter queue. */
    GLN_QUEUE_URL: z.url(),
    GLN_DEAD_LETTER_URL: z.url(),
    GLN_JOBS_QUEUE_URL: z.url(),
    GLN_JOBS_QUEUE_ARN: z.string().startsWith("arn:"),
    GLN_BUILDS_QUEUE_URL: z.url(),
    GLN_BUILDS_QUEUE_ARN: z.string().startsWith("arn:"),
    GLN_SCHEDULE_GROUP: z.string().min(1),
    GLN_SCHEDULER_ROLE_ARN: z.string().startsWith("arn:"),
  })
  .parse(process.env);

async function start() {
  const { Parameter } = await new SSMClient({}).send(
    new GetParameterCommand({ Name: host.GLN_APP_KEY_PARAM, WithDecryption: true }),
  );
  if (!Parameter?.Value) throw new Error(`SSM parameter ${host.GLN_APP_KEY_PARAM} has no value.`);
  process.env.GLN_APP_KEY = Parameter.Value;

  const sqs = new SQSClient({});
  setEngine(
    sqsEngine({
      sqs,
      scheduler: new SchedulerClient({}),
      clock: { now: () => new Date() },
      queues: {
        jobs: { url: host.GLN_JOBS_QUEUE_URL, arn: host.GLN_JOBS_QUEUE_ARN },
        builds: { url: host.GLN_BUILDS_QUEUE_URL, arn: host.GLN_BUILDS_QUEUE_ARN },
      },
      schedules: { group: host.GLN_SCHEDULE_GROUP, roleArn: host.GLN_SCHEDULER_ROLE_ARN },
    }),
  );
  // Job modules build their clients from env.ts when they load, so only now.
  const { jobs } = await import("./jobs/index.ts");
  return sqsHost({
    sqs,
    jobs,
    queueUrl: host.GLN_QUEUE_URL,
    deadLetterUrl: host.GLN_DEAD_LETTER_URL,
  });
}
// Once per container. A failed start is not cached, so the next batch tries again.
let started: ReturnType<typeof start> | undefined;

/** SQS FIFO event source, batch size 1, with `ReportBatchItemFailures`. */
export async function handler(event: { Records: SqsJobRecord[] }) {
  started ??= start().catch((error: unknown) => {
    started = undefined;
    throw error;
  });
  return (await started)(event);
}
