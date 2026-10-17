import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { sqsEngine } from "@galena/integrations/jobs/aws";
import { setEngine } from "./engine.ts";
import { engineEnv, setAppKey } from "./env.ts";
import { sqsLambda } from "./lambda-host.ts";

const host = engineEnv();

/** The jobs function: every job but the HTML build, starting others through SQS and Scheduler. */
export const handler = sqsLambda(async (sqs) => {
  const { Parameter } = await new SSMClient({}).send(
    new GetParameterCommand({ Name: host.GLN_APP_KEY_PARAM, WithDecryption: true }),
  );
  if (!Parameter?.Value) throw new Error(`SSM parameter ${host.GLN_APP_KEY_PARAM} has no value.`);
  setAppKey(Parameter.Value);
  setEngine(
    sqsEngine({
      sqs,
      scheduler: new SchedulerClient({}),
      clock: { now: () => new Date() },
      queues: {
        jobs: { url: host.GLN_JOBS_QUEUE_URL, arn: host.GLN_JOBS_QUEUE_ARN },
        builds: { url: host.GLN_BUILDS_QUEUE_URL, arn: host.GLN_BUILDS_QUEUE_ARN },
      },
      schedules: {
        group: host.GLN_SCHEDULE_GROUP,
        roleArn: host.GLN_SCHEDULER_ROLE_ARN,
        deadLetterArn: host.GLN_SCHEDULE_DEAD_LETTER_ARN,
      },
    }),
  );
  // Job modules build their clients, with the app key, when they load: so only now.
  return (await import("./jobs/index.ts")).jobs;
});
